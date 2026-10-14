import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import { DownloadError, type DownloadFetch, downloadVerified } from "./download";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ompdesk-setup-download-"));
});
afterEach(async () => {
	await rm(dir, RM_TEMP);
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A response that streams `chunks` with `Content-Length` (unless `length` is null). */
function respond(chunks: Uint8Array[], options: { status?: number; length?: number | null } = {}): Response {
	const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const length = options.length === undefined ? size : options.length;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	return new Response(body, {
		status: options.status ?? 200,
		headers: length === null ? {} : { "content-length": String(length) },
	});
}

describe("downloadVerified", () => {
	const a = new Uint8Array(3000).fill(1);
	const b = new Uint8Array(1000).fill(2);
	const whole = new Uint8Array([...a, ...b]);

	it("streams the file into place with byte progress against the announced size, then checks its SHA-256", async () => {
		const file = join(dir, "downloads", "PortableGit.7z.exe");
		const progress: { received: number; total: number | null }[] = [];
		const requests: { url: string; init: RequestInit }[] = [];
		const fetch: DownloadFetch = async (url, init) => {
			requests.push({ url, init });
			return respond([a, b]);
		};
		await downloadVerified({
			url: "https://example.test/PortableGit.7z.exe",
			sha256: sha256(whole),
			file,
			signal: new AbortController().signal,
			onProgress: value => progress.push({ ...value }),
			fetch,
		});
		expect(requests.map(request => request.url)).toEqual(["https://example.test/PortableGit.7z.exe"]);
		expect(progress).toEqual([
			{ received: 0, total: 4000 },
			{ received: 3000, total: 4000 },
			{ received: 4000, total: 4000 },
		]);
		expect(new Uint8Array(await readFile(file))).toEqual(whole);
		// Only the verified file is left: no partial copy.
		expect(await readdir(join(dir, "downloads"))).toEqual(["PortableGit.7z.exe"]);
	});

	it("reports bytes without a total when the server announces no size", async () => {
		const progress: { received: number; total: number | null }[] = [];
		await downloadVerified({
			url: "https://example.test/x",
			sha256: sha256(whole),
			file: join(dir, "x"),
			signal: new AbortController().signal,
			onProgress: value => progress.push({ ...value }),
			fetch: async () => respond([a, b], { length: null }),
		});
		expect(progress.at(-1)).toEqual({ received: 4000, total: null });
	});

	it("keeps nothing that does not match its published SHA-256", async () => {
		const file = join(dir, "x");
		const error = await downloadVerified({
			url: "https://example.test/x",
			sha256: "0".repeat(64),
			file,
			signal: new AbortController().signal,
			onProgress: () => {},
			fetch: async () => respond([a, b]),
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DownloadError);
		expect(error).toMatchObject({ reason: "checksum" });
		expect((error as Error).message).toBe(`SHA-256 mismatch: expected ${"0".repeat(64)}, got ${sha256(whole)}`);
		expect(await readdir(dir)).toEqual([]);
	});

	it("calls an error status or an unreachable server a download failure", async () => {
		const options = {
			url: "https://example.test/x",
			sha256: sha256(whole),
			file: join(dir, "x"),
			signal: new AbortController().signal,
			onProgress: () => {},
		};
		await expect(downloadVerified({ ...options, fetch: async () => respond([], { status: 404 }) })).rejects.toEqual(
			new DownloadError("download", "https://example.test/x answered 404"),
		);
		await expect(
			downloadVerified({
				...options,
				fetch: async () => {
					throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.test") });
				},
			}),
		).rejects.toEqual(new DownloadError("download", "https://example.test/x: getaddrinfo ENOTFOUND example.test"));
		expect(existsSync(options.file)).toBe(false);
	});

	it("stops on abort and removes the partial file", async () => {
		const controller = new AbortController();
		const file = join(dir, "x");
		let pull = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(stream) {
				pull += 1;
				if (pull === 1) stream.enqueue(a);
				else controller.abort();
				if (controller.signal.aborted) stream.error(controller.signal.reason);
			},
		});
		const run = downloadVerified({
			url: "https://example.test/x",
			sha256: sha256(whole),
			file,
			signal: controller.signal,
			onProgress: () => {},
			fetch: async () => new Response(body, { headers: { "content-length": "4000" } }),
		});
		await expect(run).rejects.not.toBeInstanceOf(DownloadError);
		expect(controller.signal.aborted).toBe(true);
		expect(await readdir(dir)).toEqual([]);
	});
});
