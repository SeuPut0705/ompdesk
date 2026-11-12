/**
 * Known answers for the OSCrypt "v10" formats.
 *
 * Windows: produced by a real Electron 36.9.5 (`safeStorage.encryptString`) in a clean `--user-data-dir`; the key is
 * that profile's `Local State` `os_crypt.encrypted_key` (the `DPAPI` prefix, then a DPAPI blob) unwrapped with
 * `ProtectedData.Unprotect`. On 12 Nov 2026 the same Electron decrypted a value this module encrypted with that key
 * (`safeStorage.decryptString` returned the plain text), so both directions are proven against Chromium's own code.
 *
 * macOS: no Mac here; the values come from independent implementations of Chromium's documented format
 * (Python `hashlib.pbkdf2_hmac` for the key, the `openssl enc -aes-128-cbc` CLI for the cipher), never from this code.
 */
import { describe, expect, it } from "vitest";
import { createSafeStorage } from "./safe-storage";

const PLAIN = "hello ompdesk — 한글 🚀";

const ELECTRON_WINDOWS = {
	key: "dvvZEDy+CfzLDy4ah8YE3wKPjp9BXEfJSRIF0dORE7A=",
	enc: "djEwri9QjQMj1zqkCubyJCxXycFNiYAB/iJrp15St23W9viSR3QSqO3CCBJDqH6ReKGSUrBEqfThld33",
	encEmpty: "djEwKKok6w45tiZenYn3TLxL6xeQXhQ5OPIeMB4MHg==",
	/** Written by this module with the same key; real Electron decrypted it. */
	byShim: "djEw2rLzeSdnMPuizmNp4qzrpPkVl8lILqO/DQDSKvnOP9SbVVVNgWCNujTHXM219KcZI1lp6ELfeJYe",
};

const MAC = {
	password: "b21wZGVzay10ZXN0LWtleWNoYWluLXBhc3N3b3Jk",
	cases: [
		[PLAIN, "djEwwcJml+UgSsceE9UZHdfAJJtCZ0dxDhNjeuSzUbWbm9s="],
		["", "djEw7m2dJH7HSJrwWNvYG/SOgA=="],
		["xxxxxxxxxxxxxxxx", "djEwlibdIRVfDy7yzz47c68U33jGFcDWAsyj8V/ZZL5feO0="],
		["exactly sixteen!!", "djEwcdSLk7qlTIVY8NYWtoabtXGiwMIe73nJ9Ew8TtVIFx4="],
	],
} as const;

const quiet = () => undefined;

describe("safeStorage, Windows v10 (AES-256-GCM)", () => {
	const storage = createSafeStorage({ kind: "win-v10", key: ELECTRON_WINDOWS.key }, quiet);

	it("decrypts what Electron wrote", () => {
		expect(storage.decryptString(Buffer.from(ELECTRON_WINDOWS.enc, "base64"))).toBe(PLAIN);
		expect(storage.decryptString(Buffer.from(ELECTRON_WINDOWS.encEmpty, "base64"))).toBe("");
		expect(storage.decryptString(Buffer.from(ELECTRON_WINDOWS.byShim, "base64"))).toBe(PLAIN);
	});

	it("writes Electron's layout: v10, a 12-byte nonce, the ciphertext, a 16-byte tag; a fresh nonce each time", () => {
		const first = storage.encryptString(PLAIN);
		const second = storage.encryptString(PLAIN);
		expect(first.subarray(0, 3).toString("ascii")).toBe("v10");
		expect(first.length).toBe(3 + 12 + Buffer.byteLength(PLAIN) + 16);
		expect(first.equals(second)).toBe(false);
		expect(storage.decryptString(first)).toBe(PLAIN);
		expect(Buffer.from(ELECTRON_WINDOWS.enc, "base64").length).toBe(3 + 12 + Buffer.byteLength(PLAIN) + 16);
	});

	it("refuses another prefix, a tampered value and a wrong key", () => {
		const sealed = Buffer.from(ELECTRON_WINDOWS.enc, "base64");
		expect(() => storage.decryptString(Buffer.concat([Buffer.from("v11"), sealed.subarray(3)]))).toThrow(
			/does not appear to be encrypted/,
		);
		const tampered = Buffer.from(sealed);
		tampered[20] ^= 1;
		expect(() => storage.decryptString(tampered)).toThrow(/Decryption failed/);
		const other = createSafeStorage({ kind: "win-v10", key: Buffer.alloc(32, 1).toString("base64") }, quiet);
		expect(() => other.decryptString(sealed)).toThrow(/Decryption failed/);
		expect(() => storage.decryptString(Buffer.from("v10"))).toThrow();
	});
});

describe("safeStorage, macOS v10 (PBKDF2-SHA1 1003, AES-128-CBC, IV of spaces)", () => {
	const storage = createSafeStorage({ kind: "mac-v10", password: MAC.password }, quiet);

	it.each(MAC.cases)("reads %j as the independent implementation wrote it", (plain, sealed) => {
		expect(storage.decryptString(Buffer.from(sealed, "base64"))).toBe(plain);
	});

	it.each(MAC.cases)(
		"writes %j byte for byte as the independent implementation does (the cipher is deterministic)",
		(plain, sealed) => {
			expect(storage.encryptString(plain).toString("base64")).toBe(sealed);
		},
	);
});

describe("safeStorage unavailable", () => {
	it("says so, logs why once, and throws instead of storing in the clear", () => {
		const logged: string[] = [];
		const storage = createSafeStorage({ unavailable: "the keychain refused" }, message => logged.push(message));
		expect(storage.isEncryptionAvailable()).toBe(false);
		expect(logged).toEqual([expect.stringContaining("the keychain refused")]);
		expect(() => storage.encryptString("x")).toThrow(/not available/);
		expect(() => storage.decryptString(Buffer.from("v10abc"))).toThrow(/not available/);
	});

	it("is unavailable for a key of the wrong length", () => {
		const storage = createSafeStorage({ kind: "win-v10", key: Buffer.alloc(16).toString("base64") }, quiet);
		expect(storage.isEncryptionAvailable()).toBe(false);
	});
});
