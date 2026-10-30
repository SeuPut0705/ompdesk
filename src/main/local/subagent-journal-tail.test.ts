/**
 * A subagent journal read names the journal's tail where it ends (`tails`), and a read from a kept offset checks the
 * journal still has the bytes before it (`knownTail`): a paired device keeps what it read across its relaunch
 * (remote/transcript-cache.ts) and asks only for what follows, unless the journal is no longer the one it read.
 */
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import { journalTail } from "./extensions";
import { localHandlerFor } from "./index";
import type { BridgeClient, LocalCommandContext } from "./types";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, RM_TEMP);
});

const line = (text: string, timestamp: number) =>
	`${JSON.stringify({ type: "message", id: `e${timestamp}`, message: { role: "user", content: text, timestamp } })}\n`;

/** Stock's `readRpcSubagentTranscript` over `file`: the whole lines after `fromByte`, a line it cannot parse skipped. */
async function stockRead(file: string, fromByte = 0) {
	let start = fromByte;
	let reset = false;
	const { size } = await stat(file);
	if (start > size) {
		start = 0;
		reset = true;
	}
	const text = (await readFile(file)).subarray(start).toString("utf8");
	const complete = text.slice(0, text.lastIndexOf("\n") + 1);
	const entries = complete.split("\n").flatMap(entry => {
		try {
			return [JSON.parse(entry) as { message: unknown }];
		} catch {
			return [];
		}
	});
	return {
		sessionFile: file,
		fromByte: start,
		nextByte: start + Buffer.byteLength(complete),
		reset,
		entries,
		messages: entries.map(entry => entry.message),
	};
}

async function journal() {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-journal-tail-"));
	dirs.push(dir);
	const file = path.join(dir, "Scout.jsonl");
	await writeFile(file, line("one", 1) + line("two", 2));
	const asked: Array<Record<string, unknown>> = [];
	const bridge: BridgeClient = {
		connected: true,
		onEvent: () => () => {},
		request: async () => {
			throw new Error("no bridge read here");
		},
	};
	const ctx: LocalCommandContext = {
		cwd: dir,
		omp: { bin: "omp", version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		bridge,
		send: async <T>(command: Record<string, unknown>): Promise<T> => {
			asked.push(command);
			return (await stockRead(file, typeof command.fromByte === "number" ? command.fromByte : 0)) as T;
		},
	};
	const read = localHandlerFor("get_subagent_messages");
	if (!read) throw new Error("get_subagent_messages is not handled locally");
	const ask = (params: Record<string, unknown>) =>
		read(
			{ type: "get_subagent_messages", id: "gui-1", subagentId: "Scout", imageRefs: true, ...params },
			ctx,
		) as Promise<{
			messages: Array<{ content: string }>;
			fromByte: number;
			nextByte: number;
			reset: boolean;
			tail?: string;
		}>;
	return { file, ask, asked };
}

describe("a subagent journal's tail", () => {
	it("names where a read ended, and a read from there asks stock for what follows only", async () => {
		const { file, ask, asked } = await journal();
		const first = await ask({ tails: true });
		expect(first.messages.map(message => message.content)).toEqual(["one", "two"]);
		expect(first.tail).toBe(await journalTail(file, first.nextByte));
		// Stock never sees the flags.
		expect(asked[0]).toEqual({ type: "get_subagent_messages", subagentId: "Scout" });
		await appendFile(file, line("three", 3));
		const next = await ask({ tails: true, fromByte: first.nextByte, knownTail: first.tail });
		expect(next.reset).toBe(false);
		expect(next.messages.map(message => message.content)).toEqual(["three"]);
		expect(next.tail).toBe(await journalTail(file, next.nextByte));
		expect(asked).toHaveLength(2);
		// Without `tails` nothing is added.
		expect(await ask({ fromByte: next.nextByte })).not.toHaveProperty("tail");
	});

	it("reads a journal that is no longer the one kept from its start, as reset", async () => {
		const { file, ask } = await journal();
		const first = await ask({ tails: true });
		// Another journal under the path, longer than the offset kept: stock alone would read on from the middle.
		await writeFile(file, line("uno", 11) + line("dos", 12) + line("tres", 13));
		const again = await ask({ tails: true, fromByte: first.nextByte, knownTail: first.tail });
		expect(again.reset).toBe(true);
		expect(again.fromByte).toBe(0);
		expect(again.messages.map(message => message.content)).toEqual(["uno", "dos", "tres"]);
		expect(again.tail).toBe(await journalTail(file, again.nextByte));
	});
});
