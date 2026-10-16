import { createECDH } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAPID_SUBJECT, VapidStore } from "./vapid-store";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vapid-"));
	file = join(dir, "web-push.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("VapidStore", () => {
	it("makes a P-256 keypair once, in a file only its owner can read", () => {
		const store = new VapidStore(dir);
		const keys = store.keys();
		expect(keys.subject).toBe(VAPID_SUBJECT);
		expect(keys.subject).toMatch(/^(mailto:|https:\/\/)/);
		// The uncompressed point (65 bytes, 0x04 first) and the 32-byte scalar of one pair.
		const point = Buffer.from(keys.publicKey, "base64url");
		expect(point).toHaveLength(65);
		expect(point[0]).toBe(4);
		const ecdh = createECDH("prime256v1");
		ecdh.setPrivateKey(Buffer.from(keys.privateKey, "base64url"));
		expect(ecdh.getPublicKey().equals(point)).toBe(true);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			v: 1,
			publicKey: keys.publicKey,
			privateKey: keys.privateKey,
		});
	});

	it("keeps the same keys across reloads and says only the first load made them", () => {
		const first = new VapidStore(dir);
		const keys = first.keys();
		expect(first.takeCreated()).toBe(true);
		expect(first.takeCreated()).toBe(false);
		const again = new VapidStore(dir);
		expect(again.keys()).toEqual(keys);
		expect(again.takeCreated()).toBe(false);
	});

	for (const [name, content] of [
		["not JSON", "{ nope"],
		["another shape", JSON.stringify({ v: 1, publicKey: "x", privateKey: "y" })],
		["a wrong version", JSON.stringify({ v: 2, publicKey: "A".repeat(87), privateKey: "A".repeat(43) })],
	] as const) {
		it(`makes a new pair when the file is ${name}, so the caller drops subscriptions made against the old key`, () => {
			const old = new VapidStore(dir).keys();
			writeFileSync(file, content);
			const store = new VapidStore(dir);
			const keys = store.keys();
			expect(store.takeCreated()).toBe(true);
			expect(keys.publicKey).not.toBe(old.publicKey);
			expect(new VapidStore(dir).keys()).toEqual(keys);
		});
	}

	it("refuses a pair whose halves do not match", () => {
		const a = new VapidStore(dir).keys();
		const other = new VapidStore(mkdtempSync(join(tmpdir(), "vapid-b-"))).keys();
		writeFileSync(file, JSON.stringify({ v: 1, publicKey: a.publicKey, privateKey: other.privateKey }));
		const store = new VapidStore(dir);
		const keys = store.keys();
		expect(store.takeCreated()).toBe(true);
		expect(keys.publicKey).not.toBe(a.publicKey);
	});
});
