import { appendFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import { RM_TEMP } from "../test-fake-omp";
import { TranscriptCache } from "./transcript-cache";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, RM_TEMP);
});

async function folder(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-transcript-cache-"));
	dirs.push(dir);
	return path.join(dir, "transcripts");
}

const ok = (data: unknown): RpcResponse => ({
	type: "response",
	command: "get_subagent_messages",
	success: true,
	data,
});

/**
 * A host's journal as `transcriptRead` answers it: one message per 10 bytes, `tail` naming the offset and a generation
 * that changes when the journal is replaced (the host's hash of the bytes before an offset).
 */
function host(count: number) {
	const journal = { count, generation: 1 };
	const asked: Array<{ fromByte: number; knownTail?: string }> = [];
	const tail = (byte: number) => `${journal.generation}:${byte}`;
	const fetch = async (fromByte: number, knownTail?: string) => {
		asked.push({ fromByte, ...(knownTail ? { knownTail } : {}) });
		const size = journal.count * 10;
		let start = fromByte;
		let reset = start > size;
		if (knownTail !== undefined && knownTail !== tail(start)) reset = true;
		if (reset) start = 0;
		const messages = Array.from({ length: (size - start) / 10 }, (_, index) => ({
			role: "user",
			content: `g${journal.generation} m${start / 10 + index}`,
		}));
		return ok({
			sessionFile: "/host/Scout.jsonl",
			fromByte: start,
			nextByte: size,
			reset,
			messages,
			tail: tail(size),
		});
	};
	return { journal, asked, fetch };
}

const texts = (response: RpcResponse) =>
	((response.success ? response.data : undefined) as { messages: Array<{ content: string }> }).messages.map(
		message => message.content,
	);

describe("TranscriptCache", () => {
	it("reads a journal from the host once, and then only what it gained, across a relaunch", async () => {
		const dir = await folder();
		const remote = host(3);
		const first = await new TranscriptCache(dir).readJournal("k", 0, remote.fetch);
		expect(texts(first)).toEqual(["g1 m0", "g1 m1", "g1 m2"]);
		// A fresh reader (another store, the app relaunched): one small request, the whole journal from disk.
		const relaunched = new TranscriptCache(dir);
		const again = await relaunched.readJournal("k", 0, remote.fetch);
		expect(texts(again)).toEqual(["g1 m0", "g1 m1", "g1 m2"]);
		expect(again.success && again.data).toMatchObject({ fromByte: 0, nextByte: 30, reset: false });
		expect(remote.asked).toEqual([{ fromByte: 0 }, { fromByte: 30, knownTail: "1:30" }]);
		// The agent runs on: a reader at the end gets what follows; a fresh one the whole again, with no second read.
		remote.journal.count = 5;
		expect(texts(await relaunched.readJournal("k", 30, remote.fetch))).toEqual(["g1 m3", "g1 m4"]);
		expect(texts(await new TranscriptCache(dir).readJournal("k", 0, remote.fetch))).toHaveLength(5);
		expect(remote.asked.slice(2)).toEqual([
			{ fromByte: 30, knownTail: "1:30" },
			{ fromByte: 50, knownTail: "1:50" },
		]);
	});

	it("keeps a journal the host replaced anew from the host's answer", async () => {
		const dir = await folder();
		const remote = host(3);
		const cache = new TranscriptCache(dir);
		await cache.readJournal("k", 0, remote.fetch);
		remote.journal.generation = 2;
		remote.journal.count = 4;
		const replaced = await cache.readJournal("k", 0, remote.fetch);
		expect(texts(replaced)).toEqual(["g2 m0", "g2 m1", "g2 m2", "g2 m3"]);
		expect(replaced.success && replaced.data).toMatchObject({ reset: true });
		expect(texts(await cache.readJournal("k", 0, remote.fetch))).toHaveLength(4);
		expect(remote.asked.at(-1)).toEqual({ fromByte: 40, knownTail: "2:40" });
	});

	it("answers a reader at another offset from the host, and keeps nothing from a failed or older host's read", async () => {
		const dir = await folder();
		const remote = host(3);
		const cache = new TranscriptCache(dir);
		expect(texts(await cache.readJournal("k", 20, remote.fetch))).toEqual(["g1 m2"]);
		const failed: RpcResponse = { type: "response", command: "get_subagent_messages", success: false, error: "gone" };
		await expect(cache.readJournal("k", 0, async () => failed)).resolves.toBe(failed);
		// An older host names no tail: nothing to check a kept copy by.
		await cache.readJournal("k", 0, async () => ok({ fromByte: 0, nextByte: 30, messages: [{ role: "user" }] }));
		await cache.readJournal("k", 0, remote.fetch);
		expect(remote.asked).toEqual([{ fromByte: 20 }, { fromByte: 0 }]);
	});

	it("drops a copy a crash cut mid-append and reads the journal whole again", async () => {
		const dir = await folder();
		const remote = host(3);
		await new TranscriptCache(dir).readJournal("k", 0, remote.fetch);
		const [file] = await readdir(dir);
		await appendFile(path.join(dir, file ?? ""), '{"from":30,"next":40,"tail":"1:4');
		expect(texts(await new TranscriptCache(dir).readJournal("k", 0, remote.fetch))).toHaveLength(3);
		expect(remote.asked.at(-1)).toEqual({ fromByte: 0 });
	});

	it("never appends the same segment twice when two readers ask at once", async () => {
		const dir = await folder();
		const remote = host(3);
		const cache = new TranscriptCache(dir);
		await cache.readJournal("k", 0, remote.fetch);
		remote.journal.count = 4;
		const [a, b] = await Promise.all([
			cache.readJournal("k", 0, remote.fetch),
			cache.readJournal("k", 0, remote.fetch),
		]);
		expect(texts(a)).toEqual(texts(b));
		expect(texts(await new TranscriptCache(dir).readJournal("k", 0, remote.fetch))).toHaveLength(4);
	});

	it("keeps a tail page with its version, and trims the least recently read past its bound", async () => {
		const dir = await folder();
		const cache = new TranscriptCache(dir, 3000);
		const page = { messages: [{ role: "user", content: "x".repeat(900) }], totalMessages: 1 };
		await cache.keepPage("a", "v1", page);
		await expect(new TranscriptCache(dir).page("a")).resolves.toEqual({ version: "v1", page });
		await expect(cache.page("b")).resolves.toBeNull();
		await cache.keepPage("b", "v1", page);
		await cache.keepPage("c", "v1", page);
		await cache.keepPage("d", "v1", page);
		// Trimmed in the background to three quarters of the bound.
		await expect.poll(async () => (await readdir(dir)).length).toBeLessThan(4);
		let total = 0;
		for (const name of await readdir(dir)) total += (await stat(path.join(dir, name))).size;
		expect(total).toBeLessThanOrEqual(3000);
		await expect(cache.page("d")).resolves.toEqual({ version: "v1", page });
	});
});
