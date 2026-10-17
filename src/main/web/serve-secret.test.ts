import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServeSecretStore } from "./serve-secret";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-serve-secret-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ServeSecretStore", () => {
	it("makes a 256-bit URL-safe secret on first use and keeps it in a 0600 file", () => {
		const secret = new ServeSecretStore(dir).get();
		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const file = join(dir, "web-serve-secret.json");
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, secret });
	});

	it("gives the same secret again, from memory and from a new store over the same folder", () => {
		const store = new ServeSecretStore(dir);
		const secret = store.get();
		expect(store.get()).toBe(secret);
		expect(new ServeSecretStore(dir).get()).toBe(secret);
	});

	it("makes a new secret when the file is corrupt or holds a secret of the wrong shape", () => {
		const file = join(dir, "web-serve-secret.json");
		writeFileSync(file, "not json");
		const first = new ServeSecretStore(dir).get();
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		writeFileSync(file, JSON.stringify({ v: 1, secret: "short" }));
		const second = new ServeSecretStore(dir).get();
		expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(second).not.toBe(first);
		expect(new ServeSecretStore(dir).get()).toBe(second);
	});

	it("never gives two installs the same secret", () => {
		const other = mkdtempSync(join(tmpdir(), "web-serve-secret-"));
		try {
			expect(new ServeSecretStore(other).get()).not.toBe(new ServeSecretStore(dir).get());
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});
