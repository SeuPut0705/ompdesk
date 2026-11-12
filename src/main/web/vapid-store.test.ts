import { createECDH } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVapid } from "./vapid-store";

const VAPID_SUBJECT = "https://github.com/SeuPut0705/ompdesk";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vapid-"));
	file = join(dir, "web-push.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What the core keeps: the private half never reaches this process, so a test reads it from the file. */
const stored = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { privateKey: string };

describe("loadVapid (the core's VAPID keypair)", () => {
	it("makes a P-256 keypair once, in a file only its owner can read", async () => {
		const keys = await loadVapid(dir);
		expect(keys.subject).toBe(VAPID_SUBJECT);
		expect(keys.subject).toMatch(/^(mailto:|https:\/\/)/);
		// The uncompressed point (65 bytes, 0x04 first) and the 32-byte scalar of one pair.
		const point = Buffer.from(keys.publicKey, "base64url");
		expect(point).toHaveLength(65);
		expect(point[0]).toBe(4);
		const { privateKey } = stored(file);
		expect(Buffer.from(privateKey, "base64url")).toHaveLength(32);
		const ecdh = createECDH("prime256v1");
		ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
		expect(ecdh.getPublicKey().equals(point)).toBe(true);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, publicKey: keys.publicKey, privateKey });
	});

	it("keeps the same keys across reloads and says only the first load made them", async () => {
		const first = await loadVapid(dir);
		expect(first.created).toBe(true);
		expect(await loadVapid(dir)).toEqual({ ...first, created: false });
	});

	for (const [name, content] of [
		["not JSON", "{ nope"],
		["another shape", JSON.stringify({ v: 1, publicKey: "x", privateKey: "y" })],
		["a wrong version", JSON.stringify({ v: 2, publicKey: "A".repeat(87), privateKey: "A".repeat(43) })],
	] as const) {
		it(`makes a new pair when the file is ${name}, so the caller drops subscriptions made against the old key`, async () => {
			const old = await loadVapid(dir);
			writeFileSync(file, content);
			const keys = await loadVapid(dir);
			expect(keys.created).toBe(true);
			expect(keys.publicKey).not.toBe(old.publicKey);
			expect(await loadVapid(dir)).toEqual({ ...keys, created: false });
		});
	}

	it("refuses a pair whose halves do not match", async () => {
		const a = await loadVapid(dir);
		const otherDir = mkdtempSync(join(tmpdir(), "vapid-b-"));
		try {
			await loadVapid(otherDir);
			const other = stored(join(otherDir, "web-push.json"));
			writeFileSync(file, JSON.stringify({ v: 1, publicKey: a.publicKey, privateKey: other.privateKey }));
			const keys = await loadVapid(dir);
			expect(keys.created).toBe(true);
			expect(keys.publicKey).not.toBe(a.publicKey);
		} finally {
			rmSync(otherDir, { recursive: true, force: true });
		}
	});
});
