import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServeSecretStore } from "./serve-secret";

// The secret is made and kept by the core (crates/core/src/web/store.rs `serve_secret`): these cases run against the
// real process, so the first read is a request (`ready()`), then `get()` is synchronous.
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-serve-secret-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const secretOf = async (folder: string): Promise<string> => {
	const store = new ServeSecretStore(folder);
	await store.ready();
	return store.get();
};

describe("ServeSecretStore", () => {
	it("makes a 256-bit URL-safe secret on first use and keeps it in a 0600 file", async () => {
		const secret = await secretOf(dir);
		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const file = join(dir, "web-serve-secret.json");
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, secret });
	});

	it("gives the same secret again, from memory and from a new store over the same folder", async () => {
		const store = new ServeSecretStore(dir);
		await store.ready();
		const secret = store.get();
		expect(store.get()).toBe(secret);
		expect(await secretOf(dir)).toBe(secret);
	});

	it("makes a new secret when the file is corrupt or holds a secret of the wrong shape", async () => {
		const file = join(dir, "web-serve-secret.json");
		writeFileSync(file, "not json");
		const first = await secretOf(dir);
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		writeFileSync(file, JSON.stringify({ v: 1, secret: "short" }));
		const second = await secretOf(dir);
		expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(second).not.toBe(first);
		expect(await secretOf(dir)).toBe(second);
	});

	it("never gives two installs the same secret", async () => {
		const other = mkdtempSync(join(tmpdir(), "web-serve-secret-"));
		try {
			expect(await secretOf(other)).not.toBe(await secretOf(dir));
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("is read only after ready() has resolved", async () => {
		const store = new ServeSecretStore(dir);
		expect(() => store.get()).toThrow("before ServeSecretStore.ready()");
		await store.ready();
		expect(store.get()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
});
