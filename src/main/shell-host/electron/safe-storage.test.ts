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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSafeStorage, keychainFetcher } from "./safe-storage";

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
	const storage = createSafeStorage({ kind: "win-v10", key: ELECTRON_WINDOWS.key }, { warn: quiet });

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
		const other = createSafeStorage(
			{ kind: "win-v10", key: Buffer.alloc(32, 1).toString("base64") },
			{ warn: quiet },
		);
		expect(() => other.decryptString(sealed)).toThrow(/Decryption failed/);
		expect(() => storage.decryptString(Buffer.from("v10"))).toThrow();
	});
});

describe("safeStorage, macOS v10 (PBKDF2-SHA1 1003, AES-128-CBC, IV of spaces)", () => {
	const storage = createSafeStorage({ kind: "mac-v10", password: MAC.password }, { warn: quiet });

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
		const storage = createSafeStorage(
			{ unavailable: "the keychain refused" },
			{ warn: message => logged.push(message) },
		);
		expect(storage.isEncryptionAvailable()).toBe(false);
		expect(logged).toEqual([expect.stringContaining("the keychain refused")]);
		expect(() => storage.encryptString("x")).toThrow(/not available/);
		expect(() => storage.decryptString(Buffer.from("v10abc"))).toThrow(/not available/);
	});

	it("is unavailable for a key of the wrong length", () => {
		const storage = createSafeStorage({ kind: "win-v10", key: Buffer.alloc(16).toString("base64") }, { warn: quiet });
		expect(storage.isEncryptionAvailable()).toBe(false);
	});
});

describe("safeStorage on macOS reads the keychain lazily", () => {
	const key = { kind: "mac-v10", password: MAC.password } as const;

	it("fetches nothing until the first call of any method, then once", () => {
		let fetched = 0;
		const storage = createSafeStorage(
			{ kind: "mac-v10-lazy" },
			{
				warn: quiet,
				fetchKey: () => {
					fetched += 1;
					return key;
				},
			},
		);
		expect(fetched).toBe(0);
		expect(storage.isEncryptionAvailable()).toBe(true);
		expect(fetched).toBe(1);
		expect(storage.decryptString(Buffer.from(MAC.cases[0][1], "base64"))).toBe(PLAIN);
		storage.encryptString("x");
		expect(fetched).toBe(1);
	});

	it.each([
		["encryptString", (s: ReturnType<typeof createSafeStorage>) => s.encryptString("x")],
		[
			"decryptString",
			(s: ReturnType<typeof createSafeStorage>) => s.decryptString(Buffer.from(MAC.cases[0][1], "base64")),
		],
		["getSelectedStorageBackend", (s: ReturnType<typeof createSafeStorage>) => s.getSelectedStorageBackend()],
	])("%s is the first call that triggers it", (_name, call) => {
		let fetched = 0;
		const storage = createSafeStorage(
			{ kind: "mac-v10-lazy" },
			{
				warn: quiet,
				fetchKey: () => {
					fetched += 1;
					return key;
				},
			},
		);
		call(storage);
		expect(fetched).toBe(1);
	});

	it("a refusal is logged once, and a missing reader is unavailable", () => {
		const logged: string[] = [];
		const refused = createSafeStorage(
			{ kind: "mac-v10-lazy" },
			{ warn: m => logged.push(m), fetchKey: () => ({ unavailable: "denied" }) },
		);
		expect(refused.isEncryptionAvailable()).toBe(false);
		expect(refused.isEncryptionAvailable()).toBe(false);
		expect(logged).toHaveLength(1);
		expect(createSafeStorage({ kind: "mac-v10-lazy" }, { warn: quiet }).isEncryptionAvailable()).toBe(false);
	});

	// The shell binary is a real executable on macOS; Windows cannot run a script file without a shell, and Windows
	// never reads a keychain, so the run itself is checked where it happens.
	it.skipIf(process.platform === "win32")(
		"the real reader runs the shell binary with --keychain-key and reads its JSON line",
		() => {
			const script = `console.log(JSON.stringify(process.argv[2] === "--keychain-key" && process.argv[3] === "UD" ? ${JSON.stringify(key)} : { unavailable: "args " + process.argv.slice(2).join(" ") }))`;
			const exe = writeFakeExe(script);
			expect(keychainFetcher(exe, "UD")()).toEqual(key);
			expect(keychainFetcher(exe, "other")()).toEqual({ unavailable: "args --keychain-key other" });
			const garbage = writeFakeExe('console.log("not json")');
			expect(keychainFetcher(garbage, "UD")()).toMatchObject({ unavailable: expect.stringContaining("unreadable") });
		},
	);

	it("a binary that cannot run is unavailable with the reason, never a throw", () => {
		expect(keychainFetcher(join(tmpdir(), "no-such-shell-binary.exe"), "UD")()).toMatchObject({
			unavailable: expect.stringContaining("could not be read"),
		});
	});
});

/** An executable that runs `script` with Node: a `.cmd` on Windows, a shell script elsewhere. */
function writeFakeExe(script: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-fake-shell-"));
	const js = join(dir, "main.js");
	writeFileSync(js, script);
	const file = join(dir, process.platform === "win32" ? "shell.cmd" : "shell");
	writeFileSync(
		file,
		process.platform === "win32"
			? `@"${process.execPath}" "${js}" %*\r\n`
			: `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`,
		{ mode: 0o755 },
	);
	return file;
}

describe("a keychain that would ask", () => {
	it("is unavailable for the run, the one-shot runs once, and the reason is the shell's word", () => {
		let fetched = 0;
		const storage = createSafeStorage(
			{ kind: "mac-v10-lazy" },
			{
				warn: quiet,
				fetchKey: () => {
					fetched += 1;
					return { unavailable: "keychain-would-ask" };
				},
			},
		);
		expect(storage.getUnavailableReason()).toBe("keychain-would-ask");
		expect(storage.isEncryptionAvailable()).toBe(false);
		expect(() => storage.encryptString("x")).toThrow(/not available/);
		expect(() => storage.decryptString(Buffer.from("v10abc"))).toThrow(/not available/);
		expect(storage.getUnavailableReason()).toBe("keychain-would-ask");
		expect(fetched).toBe(1);
	});

	it("reports no reason while it works", () => {
		const storage = createSafeStorage({ kind: "mac-v10", password: MAC.password }, { warn: quiet });
		expect(storage.getUnavailableReason()).toBeNull();
	});
});
