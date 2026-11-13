import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcErrorCode } from "../shared/ipc-error-codes";
import { KEYCHAIN_WOULD_ASK } from "../shared/keychain";
import type { MailAccountDraft } from "../shared/mail-accounts";
import { MailAccounts, type SecretBox } from "./mail-accounts";
import { type FakeImap, startFakeImap } from "./routines/fake-imap";
import { createSafeStorage } from "./shell-host/electron/safe-storage";

/** A keystore that marks what it sealed, so a test can tell a sealed password from a plain one. */
function box(): SecretBox & { reads: number } {
	const sealed = {
		reads: 0,
		available: () => true,
		encrypt: (text: string) => Buffer.from(`sealed:${Buffer.from(text).toString("hex")}`),
		decrypt: (data: Buffer) => {
			sealed.reads++;
			const text = data.toString();
			if (!text.startsWith("sealed:")) throw new Error("not sealed here");
			return Buffer.from(text.slice(7), "hex").toString();
		},
	};
	return sealed;
}

let dir: string;
let imap: FakeImap | null = null;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompdesk-mail-"));
});
afterEach(async () => {
	await imap?.close();
	imap = null;
	rmSync(dir, { recursive: true, force: true });
});

const draft = (overrides: Partial<MailAccountDraft> = {}): MailAccountDraft => ({
	label: "Work",
	host: "imap.example.com",
	port: 993,
	username: "owner@example.com",
	mailbox: "INBOX",
	password: 'pa55 "word"',
	...overrides,
});

/** Every byte the store wrote under `dir`, as text. */
function written(): string {
	const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
	return files.map(entry => readFileSync(join(entry.parentPath, entry.name), "utf8")).join("\n");
}

describe("MailAccounts", () => {
	it("keeps the password sealed on disk and out of every state, and an edit without one keeps it", () => {
		const keystore = box();
		const accounts = new MailAccounts({ dir, box: keystore });
		const state = accounts.save(draft());
		const [account] = state.accounts;
		expect(account).toMatchObject({
			label: "Work",
			host: "imap.example.com",
			address: "owner@example.com",
			hasPassword: true,
		});
		expect(JSON.stringify(state)).not.toContain("pa55");
		expect(written()).not.toContain("pa55");
		expect(written()).not.toContain('"password"');

		accounts.save(draft({ label: "Work mail", password: undefined }), account?.id);
		// A relaunch reads the account back and decrypts the password only when it logs in.
		const reloaded = new MailAccounts({ dir, box: keystore });
		expect(reloaded.state().accounts).toEqual([expect.objectContaining({ label: "Work mail", hasPassword: true })]);
		expect(keystore.reads).toBe(0);
	});

	it("refuses a new account without a password, a bad host or port, and a label another account has", () => {
		const accounts = new MailAccounts({ dir, box: box() });
		expect(() => accounts.save(draft({ password: "" }))).toThrow("Invalid mail account: password");
		expect(() => accounts.save(draft({ host: "imap example.com" }))).toThrow("Invalid mail account: host");
		expect(() => accounts.save(draft({ port: 0 }))).toThrow("Invalid mail account: port");
		accounts.save(draft());
		expect(() => accounts.save(draft({ label: "work" }))).toThrow("another account has it");
		const unsafe = new MailAccounts({ dir, box: { ...box(), available: () => false } });
		expect(() => unsafe.save(draft({ label: "Home" }))).toThrow("cannot store a password safely");
	});

	it("names an account by label (case aside) or id, and removing it deletes its sealed password", () => {
		const accounts = new MailAccounts({ dir, box: box() });
		const id = accounts.save(draft()).accounts[0]?.id ?? "";
		expect(accounts.resolve("work")).toEqual({ id, label: "Work", address: "owner@example.com" });
		expect(accounts.resolve(id)?.id).toBe(id);
		expect(accounts.resolve("Home")).toBeNull();
		accounts.remove(id);
		expect(accounts.state().accounts).toEqual([]);
		expect(written()).not.toContain("sealed:");
	});

	it("logs in with the sealed password to read the mailbox, and a test says the count or the server's reason", async () => {
		imap = await startFakeImap();
		const server = imap;
		server.state.password = 'pa55 "word"';
		server.mail.push({ uid: 1, headers: "Subject: one" }, { uid: 2, headers: "Subject: two" });
		const keystore = box();
		const accounts = new MailAccounts({ dir, box: keystore, connect: () => server.connect });
		const id = accounts.save(draft({ host: "127.0.0.1", port: server.port })).accounts[0]?.id ?? "";

		const reloaded = new MailAccounts({ dir, box: keystore, connect: () => server.connect });
		expect(await reloaded.test(id)).toEqual({ ok: true, messages: 2 });
		expect(await reloaded.test(id)).toEqual({ ok: true, messages: 2 });
		// One keystore read, then the password is kept in memory.
		expect(keystore.reads).toBe(1);

		server.state.password = "changed";
		const refused = await reloaded.test(id);
		expect(refused).toEqual({ ok: false, error: "could not login: [AUTHENTICATIONFAILED] Invalid credentials" });
		expect(JSON.stringify(refused)).not.toContain("pa55");
	});
});

/** A keystore that is the real shim's `safeStorage` over a fake key fetch: the mock macOS keychain. */
function wouldAskBox(): SecretBox & { fetches: number } {
	const state = { fetches: 0 };
	const storage = createSafeStorage(
		{ kind: "mac-v10-lazy" },
		{
			warn: () => undefined,
			fetchKey: () => {
				state.fetches += 1;
				return { unavailable: KEYCHAIN_WOULD_ASK };
			},
		},
	);
	return {
		get fetches() {
			return state.fetches;
		},
		available: () => storage.isEncryptionAvailable(),
		blocked: () => storage.getUnavailableReason(),
		encrypt: text => storage.encryptString(text),
		decrypt: data => storage.decryptString(data),
	};
}

describe("MailAccounts when the keychain would ask", () => {
	function twoStored(): void {
		const sealing = new MailAccounts({ dir, box: box() });
		sealing.save(draft({ label: "Work" }));
		sealing.save(draft({ label: "Home", username: "home@example.com" }));
		sealing.save(draft({ label: "Draftless", username: "x@example.com", password: "pw" }));
	}

	it("marks each account whose password is stored as needing re-entry, asks the keychain once, and names no password", () => {
		twoStored();
		const keystore = wouldAskBox();
		const accounts = new MailAccounts({ dir, box: keystore });
		const state = accounts.state();
		expect(state.accounts.map(account => [account.label, account.needsReentry, account.hasPassword])).toEqual([
			["Work", true, false],
			["Home", true, false],
			["Draftless", true, false],
		]);
		accounts.state();
		accounts.resolve("Work");
		expect(keystore.fetches).toBe(1);
	});

	it("does not touch the keychain for an account without a stored password, nor for an empty list", () => {
		const keystore = wouldAskBox();
		expect(new MailAccounts({ dir, box: keystore }).state().accounts).toEqual([]);
		expect(keystore.fetches).toBe(0);
	});

	it("never logs in: a poll fails before it connects, and the keychain is not asked again", async () => {
		twoStored();
		const keystore = wouldAskBox();
		let connected = 0;
		const accounts = new MailAccounts({
			dir,
			box: keystore,
			connect: () => () => {
				connected += 1;
				return Promise.reject(new Error("must not connect"));
			},
		});
		const [work] = accounts.state().accounts;
		await expect(accounts.read(work?.id ?? "", null)).rejects.toThrow(/enter it again in Settings/);
		expect(await accounts.test(work?.id ?? "")).toMatchObject({ ok: false });
		expect(connected).toBe(0);
		expect(keystore.fetches).toBe(1);
	});

	it("fails to save a new password with the reason, and writes nothing", () => {
		const keystore = wouldAskBox();
		const accounts = new MailAccounts({ dir, box: keystore });
		let failure: unknown;
		try {
			accounts.save(draft());
		} catch (error) {
			failure = error;
		}
		expect(ipcErrorCode(failure)).toBe("keychain_would_ask");
		expect(accounts.state().accounts).toEqual([]);
		expect(written()).not.toContain("pa55");
		// Re-entering an account marked above fails the same way, and a second try asks nothing more.
		try {
			accounts.save(draft());
		} catch {
			// the same refusal
		}
		expect(keystore.fetches).toBe(1);
	});

	it("an account whose password was saved this run is not marked", () => {
		const keystore = box();
		const accounts = new MailAccounts({ dir, box: { ...keystore, blocked: () => KEYCHAIN_WOULD_ASK } });
		accounts.save(draft());
		expect(accounts.state().accounts[0]).toMatchObject({ needsReentry: false, hasPassword: true });
	});
});
