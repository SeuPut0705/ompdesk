/**
 * The stored update token against a macOS keychain that would ask for the login password: the real shim `safeStorage`
 * with a fake key fetch (the "mock keychain") that answers `keychain-would-ask`. Nothing here touches a keychain.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcErrorCode } from "../shared/ipc-error-codes";
import { KEYCHAIN_WOULD_ASK } from "../shared/keychain";
import { createSafeStorage, type KeyFetcher } from "./shell-host/electron/safe-storage";

const holder = vi.hoisted(() => ({ userData: "", safeStorage: null as unknown }));
vi.mock("electron", () => ({
	app: { getPath: () => holder.userData },
	net: { fetch: vi.fn() },
	get safeStorage() {
		return holder.safeStorage;
	},
}));
vi.mock("./shell-env", () => ({ resolveLoginShellEnv: async () => ({ env: {} }), spawnPath: async () => "" }));
vi.mock("node:child_process", async importOriginal => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFile: (_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) =>
		done(new Error("no gh"), ""),
}));

const WORKING_KEY = { kind: "mac-v10", password: Buffer.from("test-password").toString("base64") } as const;

let fetches: number;

function keychain(answer: ReturnType<KeyFetcher>): void {
	fetches = 0;
	holder.safeStorage = createSafeStorage(
		{ kind: "mac-v10-lazy" },
		{
			warn: () => undefined,
			fetchKey: () => {
				fetches += 1;
				return answer;
			},
		},
	);
}

async function authModule() {
	return import("./update-auth");
}

beforeEach(() => {
	holder.userData = mkdtempSync(join(tmpdir(), "ompdesk-update-auth-"));
	vi.resetModules();
	delete process.env.GH_TOKEN;
	delete process.env.GITHUB_TOKEN;
});
afterEach(() => {
	rmSync(holder.userData, { recursive: true, force: true });
	delete process.env.GH_TOKEN;
});

const tokenFile = () => join(holder.userData, "update-token.bin");

describe("a stored update token when the keychain would ask", () => {
	it("is dropped, the file removed and the reason kept, and the keychain is asked once", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { resolveUpdateToken, updateAuthInfo } = await authModule();
		expect(await resolveUpdateToken()).toBeUndefined();
		expect(existsSync(tokenFile())).toBe(false);
		expect(readFileSync(join(holder.userData, "update-token.dropped"), "utf8")).toBe(KEYCHAIN_WOULD_ASK);
		expect(await resolveUpdateToken()).toBeUndefined();
		expect(await updateAuthInfo()).toMatchObject({
			source: null,
			hasStoredToken: false,
			droppedReason: KEYCHAIN_WOULD_ASK,
		});
		expect(fetches).toBe(1);
	});

	it("leaves the keychain alone while GH_TOKEN answers: the stored token is never read", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		process.env.GH_TOKEN = "from-env";
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { resolveUpdateToken } = await authModule();
		expect(await resolveUpdateToken()).toEqual({ token: "from-env", source: "env" });
		expect(fetches).toBe(0);
		expect(existsSync(tokenFile())).toBe(true);
	});

	it("uses the environment once the token is dropped", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { resolveUpdateToken } = await authModule();
		expect(await resolveUpdateToken()).toBeUndefined();
		process.env.GH_TOKEN = "later-env";
		expect(await resolveUpdateToken()).toEqual({ token: "later-env", source: "env" });
		expect(fetches).toBe(1);
	});

	it("refuses to save a new one with the same reason, without asking the keychain again", async () => {
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { storeUpdateToken } = await authModule();
		const failure = await storeUpdateToken("ghp_secret").catch((error: unknown) => error);
		expect(ipcErrorCode(failure)).toBe("keychain_would_ask");
		await storeUpdateToken("ghp_secret").catch(() => undefined);
		expect(fetches).toBe(1);
		expect(existsSync(tokenFile())).toBe(false);
	});

	it("another reason keeps the old code and drops nothing", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		keychain({ unavailable: "access to the keychain item was denied" });
		const { resolveUpdateToken, storeUpdateToken } = await authModule();
		expect(await resolveUpdateToken()).toBeUndefined();
		expect(existsSync(tokenFile())).toBe(true);
		expect(ipcErrorCode(await storeUpdateToken("x").catch((error: unknown) => error))).toBe(
			"safe_storage_unavailable",
		);
	});
});

describe("a stored update token when the keychain answers", () => {
	it("saves, reads back, and clears the dropped marker", async () => {
		mkdirSync(holder.userData, { recursive: true });
		writeFileSync(join(holder.userData, "update-token.dropped"), KEYCHAIN_WOULD_ASK);
		keychain(WORKING_KEY);
		const { storeUpdateToken, resolveUpdateToken, updateAuthInfo } = await authModule();
		await storeUpdateToken("ghp_secret");
		expect(await resolveUpdateToken()).toEqual({ token: "ghp_secret", source: "stored" });
		expect(await updateAuthInfo()).toMatchObject({ hasStoredToken: true, droppedReason: null });
		expect(fetches).toBe(1);
	});
});
