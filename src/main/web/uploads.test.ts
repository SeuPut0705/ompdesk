/** `POST /upload`'s storage: names, the 25 MiB file cap, the 200 MiB daily cap, the 24 h TTL, 0600/0700 modes. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeUploadName, UPLOAD_TTL_MS, UploadError, UploadStore } from "./uploads";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "web-uploads-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A request carrying `file` as multipart field `file`. */
async function request(name: string, bytes: Uint8Array, field = "file", declare = true): Promise<IncomingMessage> {
	const form = new FormData();
	form.set(field, new File([new Uint8Array(bytes)], name));
	const encoded = new Response(form);
	const body = Buffer.from(await encoded.arrayBuffer());
	const headers: Record<string, string> = { "content-type": encoded.headers.get("content-type") ?? "" };
	if (declare) headers["content-length"] = String(body.length);
	return Object.assign(Readable.from([body]), { headers }) as unknown as IncomingMessage;
}

const fileMaxBytes = 1000;
const store = (now = () => Date.now()) =>
	new UploadStore({ root, now, fileMaxBytes, dailyMaxBytes: 2500, ttlMs: UPLOAD_TTL_MS });

describe("safeUploadName", () => {
	it("keeps one safe path segment", () => {
		expect(safeUploadName("photo.jpg")).toBe("photo.jpg");
		expect(safeUploadName("../../etc/passwd")).toBe("passwd");
		expect(safeUploadName("C:\\Users\\me\\a b.png")).toBe("a b.png");
		expect(safeUploadName(".hidden")).toBe("hidden");
		expect(safeUploadName("a\u0000b\nc.txt")).toBe("abc.txt");
		expect(safeUploadName("")).toBe("upload");
		expect(safeUploadName("x".repeat(300))).toHaveLength(200);
	});
});

describe("UploadStore", () => {
	it("stores a file under <root>/<device>/<uuid>/<name> with owner-only modes", async () => {
		const uploads = store();
		const stored = await uploads.receive("dev1", await request("pic.png", new Uint8Array([1, 2, 3])));
		expect(stored).toMatchObject({ name: "pic.png", size: 3 });
		expect(stored.path.startsWith(join(root, "dev1"))).toBe(true);
		expect([...readFileSync(stored.path)]).toEqual([1, 2, 3]);
		if (process.platform !== "win32") {
			expect(statSync(stored.path).mode & 0o777).toBe(0o600);
			expect(statSync(join(stored.path, "..")).mode & 0o777).toBe(0o700);
		}
		expect(uploads.owns("dev1", stored.path)).toBe(true);
		expect(uploads.owns("dev2", stored.path)).toBe(false);
		expect(uploads.owns("dev1", join(root, "dev1", "..", "dev2", "x"))).toBe(false);
	});

	it("never lets a file name leave its folder", async () => {
		const stored = await store().receive("dev1", await request("../../evil.sh", new Uint8Array([1])));
		expect(stored.name).toBe("evil.sh");
		expect(stored.path.startsWith(join(root, "dev1"))).toBe(true);
	});

	it("refuses a file over the cap, by its declared length and by what actually arrives", async () => {
		const uploads = store();
		const big = new Uint8Array(fileMaxBytes + 1);
		await expect(uploads.receive("dev1", await request("big.bin", big))).rejects.toMatchObject({ status: 413 });
		const huge = new Uint8Array(fileMaxBytes + 100_000);
		await expect(uploads.receive("dev1", await request("huge.bin", huge, "file", false))).rejects.toMatchObject({
			status: 413,
		});
		expect(existsSync(join(root, "dev1"))).toBe(false);
	});

	it("refuses a body that is not multipart or has no file field", async () => {
		const uploads = store();
		const wrongType = Object.assign(Readable.from([Buffer.from("{}")]), {
			headers: { "content-type": "application/json" },
		}) as unknown as IncomingMessage;
		await expect(uploads.receive("dev1", wrongType)).rejects.toMatchObject({ status: 415 });
		await expect(
			uploads.receive("dev1", await request("a.txt", new Uint8Array([1]), "other")),
		).rejects.toBeInstanceOf(UploadError);
	});

	it("caps what a device may upload within 24 hours, and a restart does not reset it", async () => {
		const uploads = store();
		const chunk = new Uint8Array(900);
		await uploads.receive("dev1", await request("a", chunk));
		await uploads.receive("dev1", await request("b", chunk));
		await expect(uploads.receive("dev1", await request("c", chunk))).rejects.toMatchObject({ status: 429 });
		await uploads.receive("dev2", await request("a", chunk));
		await expect(store().receive("dev1", await request("c", chunk))).rejects.toMatchObject({ status: 429 });
	});

	it("deletes uploads after 24 hours and everything of a revoked device", async () => {
		let now = Date.now();
		const uploads = store(() => now);
		const old = await uploads.receive("dev1", await request("old", new Uint8Array([1])));
		const folder = join(old.path, "..");
		now += UPLOAD_TTL_MS - 1000;
		const fresh = await uploads.receive("dev1", await request("fresh", new Uint8Array([1])));
		const stamp = (target: string, at: number): void => utimesSync(target, new Date(at), new Date(at));
		stamp(join(fresh.path, ".."), now);
		stamp(folder, now - UPLOAD_TTL_MS - 5000);
		now += 2000;
		expect(await uploads.sweep()).toBe(1);
		expect(existsSync(old.path)).toBe(false);
		expect(existsSync(fresh.path)).toBe(true);
		await uploads.removeDevice("dev1");
		expect(existsSync(join(root, "dev1"))).toBe(false);
		mkdirSync(join(root, "dev1"), { recursive: true });
	});
});
