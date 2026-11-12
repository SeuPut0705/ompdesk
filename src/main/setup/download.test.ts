import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import { DownloadError, downloadVerified } from "./download";
import { type Answer, deadMirror, type Mirror, startMirror } from "./test-mirror";

let dir: string;
let mirror: Mirror | null = null;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ompdesk-setup-download-"));
});
afterEach(async () => {
	await mirror?.close();
	mirror = null;
	await rm(dir, RM_TEMP);
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** An answer that streams `chunks` with `Content-Length` (unless `length` is null), then ends or stalls. */
function stream(chunks: Uint8Array[], options: { length?: number | null; stall?: boolean } = {}): Answer {
	const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const length = options.length === undefined ? size : options.length;
	return (_request, response) => {
		response.writeHead(200, length === null ? {} : { "content-length": String(length) });
		for (const chunk of chunks) response.write(chunk);
		if (!options.stall) response.end();
	};
}

/** A mirror that serves `answer` for https://example.test/x. */
async function serve(answer: Answer): Promise<string> {
	mirror = await startMirror(url => (url === "https://example.test/x" ? answer : undefined));
	return mirror.url;
}

describe("downloadVerified", () => {
	const a = new Uint8Array(3000).fill(1);
	const b = new Uint8Array(1000).fill(2);
	const whole = new Uint8Array([...a, ...b]);
	const base = () => ({
		url: "https://example.test/x",
		sha256: sha256(whole),
		file: join(dir, "x"),
		signal: new AbortController().signal,
		onProgress: () => {},
	});

	it("streams the file into place with byte progress against the announced size, then checks its SHA-256", async () => {
		const file = join(dir, "downloads", "PortableGit.7z.exe");
		const progress: { received: number; total: number | null }[] = [];
		const mirror = await startMirror(url =>
			url === "https://example.test/PortableGit.7z.exe" ? stream([a, b]) : undefined,
		);
		try {
			await downloadVerified({
				...base(),
				url: "https://example.test/PortableGit.7z.exe",
				file,
				mirror: mirror.url,
				onProgress: value => progress.push({ ...value }),
			});
			expect(mirror.asked).toEqual(["https://example.test/PortableGit.7z.exe"]);
			expect(mirror.headers[0]?.["user-agent"]).toBe("ompdesk-setup");
		} finally {
			await mirror.close();
		}
		// The first report is nothing yet, the last is everything, and the bytes only grow in between.
		expect(progress[0]).toEqual({ received: 0, total: 4000 });
		expect(progress.at(-1)).toEqual({ received: 4000, total: 4000 });
		expect(progress.map(step => step.received)).toEqual(
			[...progress.map(step => step.received)].sort((x, y) => x - y),
		);
		expect(progress.every(step => step.total === 4000)).toBe(true);
		expect(new Uint8Array(await readFile(file))).toEqual(whole);
		// Only the verified file is left: no partial copy.
		expect(await readdir(join(dir, "downloads"))).toEqual(["PortableGit.7z.exe"]);
	});

	it("reports bytes without a total when the server announces no size, and sends the accept it was given", async () => {
		const progress: { received: number; total: number | null }[] = [];
		const url = await serve(stream([a, b], { length: null }));
		await downloadVerified({
			...base(),
			mirror: url,
			accept: "application/octet-stream",
			onProgress: value => progress.push({ ...value }),
		});
		expect(progress.at(-1)).toEqual({ received: 4000, total: null });
		expect(mirror?.headers[0]?.accept).toBe("application/octet-stream");
	});

	it("keeps nothing that does not match its published SHA-256", async () => {
		const url = await serve(stream([a, b]));
		const error = await downloadVerified({ ...base(), mirror: url, sha256: "0".repeat(64) }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(DownloadError);
		expect(error).toMatchObject({ reason: "checksum" });
		expect((error as Error).message).toBe(`SHA-256 mismatch: expected ${"0".repeat(64)}, got ${sha256(whole)}`);
		expect(await readdir(dir)).toEqual([]);
	});

	it("calls an error status or an unreachable server a download failure", async () => {
		const url = await serve({ status: 404, body: "gone" });
		await expect(downloadVerified({ ...base(), mirror: url })).rejects.toEqual(
			new DownloadError("download", "https://example.test/x answered 404"),
		);
		await expect(downloadVerified({ ...base(), mirror: await deadMirror() })).rejects.toEqual(
			new DownloadError("download", "https://example.test/x: could not connect"),
		);
		expect(existsSync(base().file)).toBe(false);
	});

	it("stops on abort and removes the partial file", async () => {
		// The abort lands at different points of the start (before the request is seen, after it); whatever was
		// opened by then is closed and removed before the call settles, where a later attempt's listing would see it.
		const url = await serve(stream([a], { length: 4000, stall: true }));
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const controller = new AbortController();
			const seen = mirror?.asked.length ?? 0;
			const run = downloadVerified({
				...base(),
				file: join(dir, `x${attempt}`),
				signal: controller.signal,
				mirror: url,
			});
			if (attempt % 2 === 1) await vi.waitFor(() => expect(mirror?.asked.length).toBeGreaterThan(seen));
			controller.abort();
			await expect(run).rejects.not.toBeInstanceOf(DownloadError);
			expect(controller.signal.aborted).toBe(true);
			expect(await readdir(dir)).toEqual([]);
		}
	});

	it("stops at once for a signal that was already aborted, without a request", async () => {
		const url = await serve(stream([a, b]));
		const controller = new AbortController();
		controller.abort(new Error("cancelled before it began"));
		await expect(downloadVerified({ ...base(), signal: controller.signal, mirror: url })).rejects.toThrow(
			"cancelled before it began",
		);
		expect(mirror?.asked).toEqual([]);
	});

	it("fails with a download error when the destination cannot be written", async () => {
		const file = join(dir, "git.zip");
		// A directory where `.part` should go: the file cannot be opened.
		await mkdir(`${file}.part`);
		const url = await serve(stream([a, b]));
		const error = await downloadVerified({ ...base(), file, mirror: url }).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(DownloadError);
		expect((error as DownloadError).reason).toBe("download");
		expect((error as Error).message).toContain(`${file}.part: `);
	});
});
