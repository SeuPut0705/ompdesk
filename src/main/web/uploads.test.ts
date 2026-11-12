/**
 * `POST /upload`'s storage, run against the real core process (the store lives in `crates/core/src/web/uploads.rs`):
 * names, the 25 MiB file cap, the 200 MiB daily cap, the 24 h TTL, 0600/0700 modes.
 *
 * Differences from the TypeScript suite, each forced by the move: `receive` was called with a node request and is now
 * the core method `web.uploads.receive` (the body and its two headers; `POST /upload` itself is the core's web
 * server's), and `safeUploadName` is no export any more, so its table runs through `store` and reads the name the
 * core kept. The store's folder is `<userData>/web-uploads`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreError, core } from "../core/process";
import { attachHere, LOCAL_UPLOAD_DEVICE, type StoredUpload, UPLOAD_TTL_MS, UploadError, UploadStore } from "./uploads";

let userData: string;
let root: string;
beforeEach(() => {
	userData = mkdtempSync(join(tmpdir(), "web-uploads-"));
	root = join(userData, "web-uploads");
});
afterEach(() => rmSync(userData, { recursive: true, force: true }));

interface Upload {
	contentType: string;
	body: Uint8Array;
	/** Absent when the request declared no length. */
	contentLength?: number;
}

/** A request carrying `file` as multipart field `file`. */
async function request(name: string, bytes: Uint8Array, field = "file", declare = true): Promise<Upload> {
	const form = new FormData();
	form.set(field, new File([new Uint8Array(bytes)], name));
	const encoded = new Response(form);
	const body = new Uint8Array(await encoded.arrayBuffer());
	return {
		contentType: encoded.headers.get("content-type") ?? "",
		body,
		...(declare ? { contentLength: body.length } : {}),
	};
}

const fileMaxBytes = 1000;
const dailyMaxBytes = 2500;

/** A store with the suite's small caps and the clock `now`; `receive` is the core's `POST /upload` handling. */
const store = (now = () => Date.now()) => {
	const uploads = new UploadStore({ userData, now, fileMaxBytes, dailyMaxBytes, ttlMs: UPLOAD_TTL_MS });
	const receive = async (deviceId: string, upload: Upload): Promise<StoredUpload> => {
		try {
			const { contentType, contentLength, body } = upload;
			const answer = await core().call<StoredUpload>(
				"web.uploads.receive",
				{
					userData,
					deviceId,
					contentType,
					contentLength,
					now: now(),
					limits: { fileMaxBytes, dailyMaxBytes, ttlMs: UPLOAD_TTL_MS },
				},
				{ bin: body },
			);
			return answer.result;
		} catch (error) {
			const status = error instanceof CoreError ? /^upload_(\d+)$/.exec(error.code)?.[1] : undefined;
			if (status !== undefined) throw new UploadError(Number(status), (error as Error).message);
			throw error;
		}
	};
	return Object.assign(uploads, { receive });
};

describe("the name a file is kept under", () => {
	it("is one safe path segment", async () => {
		const uploads = store();
		const kept = async (raw: string) => (await uploads.store("names", raw, new Uint8Array([1]))).name;
		expect(await kept("photo.jpg")).toBe("photo.jpg");
		expect(await kept("../../etc/passwd")).toBe("passwd");
		expect(await kept("C:\\Users\\me\\a b.png")).toBe("a b.png");
		expect(await kept(".hidden")).toBe("hidden");
		expect(await kept("a\u0000b\nc.txt")).toBe("abc.txt");
		expect(await kept("")).toBe("upload");
		expect(await kept("x".repeat(300))).toHaveLength(200);
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
		const wrongType: Upload = { contentType: "application/json", body: Buffer.from("{}"), contentLength: 2 };
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

	it("hands a call its device's upload once and deletes it; another device's or a made-up path is refused", async () => {
		const uploads = store();
		const stored = await uploads.receive("dev1", await request("image.jpeg", new Uint8Array([7, 8, 9])));
		await expect(uploads.take("dev2", stored.path)).rejects.toMatchObject({ status: 404 });
		expect(existsSync(stored.path)).toBe(true);
		expect([...(await uploads.take("dev1", stored.path))]).toEqual([7, 8, 9]);
		expect(existsSync(join(stored.path, ".."))).toBe(false);
		await expect(uploads.take("dev1", stored.path)).rejects.toMatchObject({ status: 404 });
		await expect(uploads.take("dev1", join(root, "dev1"))).rejects.toMatchObject({ status: 404 });
		await expect(uploads.take("dev1", join(root, "dev1", "..", "dev2", "x", "y"))).rejects.toMatchObject({
			status: 404,
		});
	});
});

describe("attachHere", () => {
	it("keeps a pathless file of this computer's own tab in its own folder, and says why when it cannot", async () => {
		const uploads = store();
		const kept = await attachHere(uploads, "clip.bin", new Uint8Array([1, 0, 2]));
		if (!kept.ok) throw new Error(kept.error);
		expect(kept.path).toContain(join(root, LOCAL_UPLOAD_DEVICE));
		expect([...readFileSync(kept.path)]).toEqual([1, 0, 2]);

		expect(await attachHere(uploads, "big.bin", new Uint8Array(fileMaxBytes + 1))).toMatchObject({
			ok: false,
			code: "file_too_large",
		});
		await attachHere(uploads, "a.bin", new Uint8Array(fileMaxBytes));
		await attachHere(uploads, "b.bin", new Uint8Array(fileMaxBytes));
		// The day's room is spent: the composer says so instead of a raw error.
		expect(await attachHere(uploads, "c.bin", new Uint8Array(fileMaxBytes))).toMatchObject({
			ok: false,
			code: "upload_refused",
		});
	});
});
