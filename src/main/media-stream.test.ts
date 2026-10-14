/**
 * `omp-media://` serves only what main registered for a renderer, resolved
 * with fs:read-binary's roots and sniffed as audio/video, and answers range
 * requests the way a media element asks for them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MediaStreams, parseRange } from "./media-stream";
import { resolveWorkspaceMedia } from "./workspace-fs";

const root = mkdtempSync(path.join(os.tmpdir(), "omp-media-stream-"));
const workspace = path.join(root, "project");
const outside = path.join(root, "outside.webm");
// EBML header + "webm" doc type, then a counting tail so ranges are checkable.
const WEBM = Uint8Array.from([
	0x1a,
	0x45,
	0xdf,
	0xa3,
	...Buffer.from("webm"),
	...Array.from({ length: 1000 }, (_, i) => i % 256),
]);

writeFileSync(outside, WEBM);
mkdirSync(path.join(workspace, "out"), { recursive: true });
writeFileSync(path.join(workspace, "out", "clip.webm"), WEBM);
writeFileSync(path.join(workspace, "notes.txt"), "plain text\n");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseRange", () => {
	it.each([
		[null, null],
		["bytes=0-", { start: 0, end: 99 }],
		["bytes=10-19", { start: 10, end: 19 }],
		["bytes=90-500", { start: 90, end: 99 }],
		["bytes=-10", { start: 90, end: 99 }],
		["bytes=-500", { start: 0, end: 99 }],
		["bytes=100-", "invalid"],
		["bytes=20-10", "invalid"],
		["bytes=-0", "invalid"],
		["bytes=-", "invalid"],
		["items=0-1", "invalid"],
		["bytes=0-1,5-6", "invalid"],
	])("%s of 100 bytes → %j", (header, expected) => {
		expect(parseRange(header, 100)).toEqual(expected);
	});
});

describe("resolveWorkspaceMedia", () => {
	it("resolves a workspace file that sniffs as video", async () => {
		await expect(resolveWorkspaceMedia(workspace, "out/clip.webm")).resolves.toEqual({
			ok: true,
			abs: path.join(workspace, "out", "clip.webm"),
			mime: "video/webm",
			size: WEBM.length,
		});
	});

	it("keeps fs:read-binary's roots: relative escapes and missing workspaces are refused", async () => {
		await expect(resolveWorkspaceMedia(workspace, "../outside.webm")).resolves.toMatchObject({
			ok: false,
			code: "path_escapes_workspace",
		});
		await expect(resolveWorkspaceMedia(null, "out/clip.webm")).resolves.toMatchObject({
			ok: false,
			code: "no_workspace",
		});
		await expect(resolveWorkspaceMedia(workspace, "out/gone.webm")).resolves.toMatchObject({
			ok: false,
			code: "file_not_found",
		});
		await expect(resolveWorkspaceMedia(workspace, "")).resolves.toMatchObject({ ok: false, code: "invalid_path" });
		await expect(resolveWorkspaceMedia(workspace, "out")).resolves.toMatchObject({ ok: false, code: "not_a_file" });
	});

	it("never streams a file that is not audio or video", async () => {
		await expect(resolveWorkspaceMedia(workspace, "notes.txt")).resolves.toMatchObject({
			ok: false,
			code: "unsupported",
		});
	});
});

describe("MediaStreams", () => {
	const request = (url: string, headers: Record<string, string> = {}, method = "GET") =>
		new Request(url, { headers, method });

	it("answers a media element's range requests from disk", async () => {
		const streams = new MediaStreams();
		const url = streams.open(outside, "video/webm", 1);
		expect(url).toMatch(/^omp-media:\/\/stream\/[\w-]{32}$/);
		const first = await streams.handle(request(url, { Range: "bytes=0-" }));
		expect(first.status).toBe(206);
		expect(first.headers.get("content-range")).toBe(`bytes 0-${WEBM.length - 1}/${WEBM.length}`);
		expect(first.headers.get("accept-ranges")).toBe("bytes");
		expect(first.headers.get("content-type")).toBe("video/webm");
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(WEBM);
		const middle = await streams.handle(request(url, { Range: "bytes=100-109" }));
		expect(middle.status).toBe(206);
		expect(middle.headers.get("content-length")).toBe("10");
		expect(new Uint8Array(await middle.arrayBuffer())).toEqual(WEBM.slice(100, 110));
		const whole = await streams.handle(request(url));
		expect(whole.status).toBe(200);
		expect((await whole.arrayBuffer()).byteLength).toBe(WEBM.length);
		const past = await streams.handle(request(url, { Range: `bytes=${WEBM.length}-` }));
		expect(past.status).toBe(416);
		expect(past.headers.get("content-range")).toBe(`bytes */${WEBM.length}`);
		const head = await streams.handle(request(url, { Range: "bytes=0-9" }, "HEAD"));
		expect(head.status).toBe(206);
		expect(head.body).toBeNull();
	});

	it("serves registered tokens only, and only until their owner releases them", async () => {
		const streams = new MediaStreams();
		expect((await streams.handle(request("omp-media://stream/guess"))).status).toBe(404);
		expect((await streams.handle(request(`omp-media://stream/${encodeURIComponent(outside)}`))).status).toBe(404);
		const url = streams.open(outside, "video/webm", 1);
		const other = streams.open(outside, "video/webm", 2);
		expect((await streams.handle(request(url, {}, "POST"))).status).toBe(404);
		// Another renderer cannot release it.
		streams.release(url, 2);
		expect((await streams.handle(request(url))).status).toBe(200);
		streams.release(url, 1);
		expect((await streams.handle(request(url))).status).toBe(404);
		streams.releaseOwner(2);
		expect((await streams.handle(request(other))).status).toBe(404);
		expect(streams.size).toBe(0);
	});
});
