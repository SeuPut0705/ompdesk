/** `/blob/<token>`: Range answers, per-device tokens, expiry, and never rendering active content inline. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOB_IDLE_TTL_MS, BlobStore, parseRange } from "./blobs";

describe("parseRange", () => {
	it("reads a single bytes range", () => {
		expect(parseRange(undefined, 10)).toBeNull();
		expect(parseRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
		expect(parseRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
		expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
		expect(parseRange("bytes=5-500", 10)).toEqual({ start: 5, end: 9 });
		expect(parseRange("bytes=-500", 10)).toEqual({ start: 0, end: 9 });
	});

	it("refuses a range it cannot serve", () => {
		for (const bad of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=-", "items=0-1", "bytes=0-1,3-4", "bytes=a-b"]) {
			expect(parseRange(bad, 10), bad).toBe("invalid");
		}
	});
});

let dir: string;
let server: Server;
let store: BlobStore;
let clock: { now: number };
let baseUrl: string;
const bytes = Buffer.from("0123456789");

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "web-blobs-"));
	clock = { now: 1_000_000 };
	store = new BlobStore({ now: () => clock.now });
	server = createServer((req, res) => {
		const device = req.headers["x-device"];
		void store.serve(typeof device === "string" ? device : "none", req.url ?? "", req, res);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
	await new Promise<void>(resolve => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
	rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
	fetch(`${baseUrl}${url}`, { headers: { "x-device": "dev1", ...headers } });

describe("BlobStore", () => {
	it("serves a file whole and by range, with the headers a browser needs", async () => {
		const file = join(dir, "clip.bin");
		writeFileSync(file, bytes);
		const url = store.addFile("dev1", { abs: file, mime: "application/octet-stream", name: "clip.bin" });
		const whole = await get(url);
		expect(whole.status).toBe(200);
		expect(Buffer.from(await whole.arrayBuffer())).toEqual(bytes);
		expect(whole.headers.get("accept-ranges")).toBe("bytes");
		expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
		expect(whole.headers.get("cache-control")).toBe("private, no-store");
		const part = await get(url, { range: "bytes=2-5" });
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(await part.text()).toBe("2345");
		const tail = await get(url, { range: "bytes=-3" });
		expect(await tail.text()).toBe("789");
		const bad = await get(url, { range: "bytes=99-" });
		expect(bad.status).toBe(416);
		expect(bad.headers.get("content-range")).toBe("bytes */10");
	});

	it("serves bytes it holds, also by range", async () => {
		const url = store.addBytes("dev1", new Uint8Array(bytes), "image/png", "a.png");
		expect(await (await get(url)).text()).toBe("0123456789");
		const part = await get(url, { range: "bytes=1-2" });
		expect(part.status).toBe(206);
		expect(await part.text()).toBe("12");
	});

	it("passes a media stream's answer through, range included", async () => {
		const url = store.addMedia("dev1", {
			url: "omp-media://stream/t",
			mime: "video/webm",
			size: 10,
			open: async range =>
				new Response(range ? "234" : "0123456789", {
					status: range ? 206 : 200,
					headers: { "content-type": "video/webm", ...(range ? { "content-range": "bytes 2-4/10" } : {}) },
				}),
		});
		const part = await get(url, { range: "bytes=2-4" });
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
		expect(await part.text()).toBe("234");
		expect(await (await get(url)).text()).toBe("0123456789");
		expect(store.mediaUrl("dev1", url)).toBe("omp-media://stream/t");
		expect(store.mediaUrl("dev2", url)).toBeNull();
	});

	it("answers 404 for another device's token, an unknown token and a released one", async () => {
		const url = store.addBytes("dev1", new Uint8Array(bytes), "text/plain");
		expect((await get(url, { "x-device": "dev2" })).status).toBe(404);
		expect((await get("/blob/nope")).status).toBe(404);
		expect((await get("/blob/../etc")).status).toBe(404);
		expect(store.release("dev2", url)).toBe(false);
		expect(store.release("dev1", url)).toBe(true);
		expect((await get(url)).status).toBe(404);
	});

	it("expires a token that sat idle for 30 minutes, and a request keeps it alive", async () => {
		const url = store.addBytes("dev1", new Uint8Array(bytes), "text/plain");
		clock.now += BLOB_IDLE_TTL_MS - 1000;
		expect((await get(url)).status).toBe(200);
		clock.now += BLOB_IDLE_TTL_MS - 1000;
		expect((await get(url)).status).toBe(200);
		clock.now += BLOB_IDLE_TTL_MS + 1;
		expect((await get(url)).status).toBe(404);
	});

	it("serves active content only as a download, and a download on request", async () => {
		for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/javascript"]) {
			const response = await get(store.addBytes("dev1", new Uint8Array(bytes), mime, "page.html"));
			expect(response.headers.get("content-disposition"), mime).toMatch(/^attachment;/);
			expect(response.headers.get("content-security-policy"), mime).toContain("sandbox");
		}
		const image = store.addBytes("dev1", new Uint8Array(bytes), "image/png", "ü.png");
		expect((await get(image)).headers.get("content-disposition")).toMatch(/^inline;/);
		const forced = await get(`${image}?dl=1`);
		expect(forced.headers.get("content-disposition")).toMatch(
			/^attachment; filename="_\.png"; filename\*=UTF-8''%C3%BC\.png/,
		);
		const marked = store.addFile("dev1", {
			abs: join(dir, "none"),
			mime: "image/png",
			name: "x.png",
			download: true,
		});
		expect((await get(marked)).status).toBe(404);
	});

	it("forgets a device's blobs and caps how many it keeps", () => {
		for (let i = 0; i < 70; i++) store.addBytes("dev1", new Uint8Array(1), "text/plain");
		expect(store.size).toBe(64);
		store.addBytes("dev2", new Uint8Array(1), "text/plain");
		store.releaseDevice("dev1");
		expect(store.size).toBe(1);
	});
});
