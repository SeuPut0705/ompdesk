/**
 * The owner's mail accounts for email routines (contract `src/shared/mail-accounts.ts`). The accounts live in
 * `<userData>/mail-accounts.json` (no password in it); each password in `<userData>/mail-accounts/<id>.bin`, encrypted
 * by the OS keystore (`SecretBox`: Electron `safeStorage` in the app). A password is decrypted only to log in, kept in
 * memory after its first use (on macOS each keystore read can ask for the login password after an update, see
 * update-auth.ts), and never returned, logged or put in an error.
 *
 * `read` is the email trigger's `MailPort.read`: one IMAP-over-TLS poll of the account's mailbox (routines/imap.ts).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { codedError } from "../shared/ipc-error-codes";
import { KEYCHAIN_WOULD_ASK } from "../shared/keychain";
import {
	MAIL_DEFAULT_MAILBOX,
	MAIL_DEFAULT_PORT,
	type MailAccount,
	type MailAccountDraft,
	type MailAccountsState,
	type MailAccountTest,
	mailAccountProblem,
} from "../shared/mail-accounts";
import { writeFileAtomicSync } from "./atomic-file";
import { type ImapConnect, type MailboxRead, type MailCursor, readMailbox } from "./routines/imap";

/** The OS keystore as the store uses it. */
export interface SecretBox {
	available(): boolean;
	/**
	 * `KEYCHAIN_WOULD_ASK` when the keystore refused to open without asking the person (it stays so for the run); null
	 * otherwise. Asking settles the keystore, so the store asks only when it holds a stored password it has not read.
	 */
	blocked?(): string | null;
	encrypt(text: string): Buffer;
	decrypt(data: Buffer): string;
}

export interface MailAccountsOptions {
	/** `<userData>`. */
	dir: string;
	box: SecretBox;
	/** How a connection to an account's server is made (TLS in the app; the tests' fake server is plain TCP). */
	connect?: (account: Pick<MailAccount, "host" | "port">) => ImapConnect;
	/**
	 * Whether a password saved this run is kept in memory (default). The parity sheet's launch turns it off so an
	 * account it saves reads as one whose password was not opened yet (`OMP_GUI_TEST_KEYCHAIN_WOULD_ASK`, index.ts).
	 */
	rememberSaved?: boolean;
	/** Told after every change (the window's list). */
	onChange?: (state: MailAccountsState) => void;
}

type Stored = Omit<MailAccount, "hasPassword" | "address" | "needsReentry">;

const CONNECT_TIMEOUT_MS = 20_000;

/** A TLS connection to `host:port` that checks the server's certificate against `host`. */
export function tlsImapConnect(account: Pick<MailAccount, "host" | "port">): ImapConnect {
	return () => {
		const { promise, resolve, reject } = Promise.withResolvers<TLSSocket>();
		const socket = tlsConnect({ host: account.host, port: account.port, servername: account.host });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`could not reach ${account.host}:${account.port} in time`));
		}, CONNECT_TIMEOUT_MS);
		socket.once("secureConnect", () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once("error", (error: Error) => {
			clearTimeout(timer);
			reject(new Error(`could not reach ${account.host}:${account.port}: ${error.message}`));
		});
		return promise;
	};
}

/** Plain TCP to `127.0.0.1:port`: only a test launch (`OMP_GUI_TEST_IMAP_PLAIN`) uses it, for its fake server. */
export function plainImapConnect(account: Pick<MailAccount, "host" | "port">): ImapConnect {
	return () => {
		const { promise, resolve, reject } = Promise.withResolvers<Socket>();
		const socket = netConnect(account.port, "127.0.0.1", () => resolve(socket));
		socket.once("error", reject);
		return promise;
	};
}

export class MailAccounts {
	readonly #options: MailAccountsOptions;
	#accounts: Stored[];
	/** Passwords decrypted (or saved) this launch, by account id. */
	readonly #passwords = new Map<string, string>();
	/** `#blocked`'s answer once it was asked; undefined before. */
	#blockedAnswer: boolean | undefined;

	constructor(options: MailAccountsOptions) {
		this.#options = options;
		this.#accounts = this.#load();
	}

	state(): MailAccountsState {
		return {
			accounts: this.#accounts.map(account => {
				const needsReentry = this.#needsReentry(account.id);
				return {
					...account,
					address: account.username.includes("@") ? account.username : "",
					hasPassword: !needsReentry && (this.#passwords.has(account.id) || this.#hasSecretFile(account.id)),
					needsReentry,
				};
			}),
		};
	}

	/**
	 * Whether the keystore refused to open without asking (`SecretBox.blocked`), asked once and only when a password is
	 * stored that this run has not read: an account without one, or already read, never touches the keystore.
	 */
	#blocked(): boolean {
		if (this.#blockedAnswer === undefined) {
			const pending = this.#accounts.some(
				account => !this.#passwords.has(account.id) && this.#hasSecretFile(account.id),
			);
			if (!pending) return false;
			this.#blockedAnswer = this.#options.box.blocked?.() === KEYCHAIN_WOULD_ASK;
		}
		return this.#blockedAnswer;
	}

	#needsReentry(id: string): boolean {
		return !this.#passwords.has(id) && this.#hasSecretFile(id) && this.#blocked();
	}

	/** Saves a new account (no `id`) or an edit; an edit without a password keeps the stored one. */
	save(draft: MailAccountDraft, id?: string): MailAccountsState {
		const existing = id === undefined ? undefined : this.#find(id);
		const clean: MailAccountDraft = {
			label: String(draft.label ?? "").trim(),
			host: String(draft.host ?? "").trim(),
			port: Number(draft.port ?? MAIL_DEFAULT_PORT),
			username: String(draft.username ?? "").trim(),
			mailbox: String(draft.mailbox ?? "").trim() || MAIL_DEFAULT_MAILBOX,
			...(typeof draft.password === "string" && draft.password !== "" ? { password: draft.password } : {}),
		};
		const problem = mailAccountProblem(
			clean,
			existing !== undefined && this.state().accounts.some(a => a.id === id && a.hasPassword),
		);
		if (problem) throw new Error(`Invalid mail account: ${problem}`);
		const label = clean.label.toLowerCase();
		if (this.#accounts.some(account => account.id !== id && account.label.toLowerCase() === label))
			throw new Error("Invalid mail account: label (another account has it)");
		const accountId = existing?.id ?? randomUUID();
		if (clean.password !== undefined) {
			if (!this.#options.box.available()) {
				if (this.#options.box.blocked?.() === KEYCHAIN_WOULD_ASK)
					throw codedError("keychain_would_ask", "macOS would ask for the login password to open the keychain");
				throw new Error("This computer cannot store a password safely");
			}
			writeFileAtomicSync(
				this.#secretFile(accountId),
				this.#options.box.encrypt(clean.password).toString("base64"),
				{
					mode: 0o600,
					dirMode: 0o700,
				},
			);
			if (this.#options.rememberSaved !== false) this.#passwords.set(accountId, clean.password);
		}
		const stored: Stored = {
			id: accountId,
			label: clean.label,
			host: clean.host,
			port: clean.port,
			username: clean.username,
			mailbox: clean.mailbox,
		};
		this.#accounts = existing
			? this.#accounts.map(account => (account.id === accountId ? stored : account))
			: [...this.#accounts, stored];
		this.#write();
		return this.state();
	}

	remove(id: string): MailAccountsState {
		this.#find(id);
		this.#accounts = this.#accounts.filter(account => account.id !== id);
		this.#passwords.delete(id);
		rmSync(this.#secretFile(id), { force: true });
		this.#write();
		return this.state();
	}

	/** The account an email routine names, by id or label (case aside). */
	resolve(name: string): { id: string; label: string; address: string } | null {
		const wanted = name.trim().toLowerCase();
		const account = this.state().accounts.find(
			item => item.id === name.trim() || item.label.toLowerCase() === wanted,
		);
		return account ? { id: account.id, label: account.label, address: account.address } : null;
	}

	/** One poll of the account's mailbox past `cursor` (none: the baseline). */
	async read(id: string, cursor: MailCursor | null): Promise<MailboxRead> {
		const account = this.#find(id);
		const connect = (this.#options.connect ?? tlsImapConnect)(account);
		return readMailbox(
			connect,
			{ username: account.username, password: this.#password(id), mailbox: account.mailbox },
			cursor,
		);
	}

	/** Log in and open the mailbox once, as a poll does; the reason in words when it cannot. */
	async test(id: string): Promise<MailAccountTest> {
		try {
			const read = await this.read(id, null);
			return { ok: true, messages: read.exists };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	#find(id: string): Stored {
		const account = this.#accounts.find(item => item.id === id);
		if (!account) throw new Error("Mail account not found");
		return account;
	}

	#password(id: string): string {
		const known = this.#passwords.get(id);
		if (known !== undefined) return known;
		let data: Buffer;
		try {
			data = Buffer.from(readFileSync(this.#secretFile(id), "utf8"), "base64");
		} catch {
			throw new Error("no password is stored for this account (Settings › Schedules › Email accounts)");
		}
		if (this.#blocked())
			throw new Error(
				"its stored password cannot be read without macOS asking for your login password; enter it again in Settings › Schedules › Email accounts",
			);
		let password: string;
		try {
			password = this.#options.box.decrypt(data);
		} catch {
			throw new Error("its stored password could not be read on this computer; enter it again in Settings");
		}
		this.#passwords.set(id, password);
		return password;
	}

	#secretsDir(): string {
		return join(this.#options.dir, "mail-accounts");
	}

	#secretFile(id: string): string {
		return join(this.#secretsDir(), `${id.replace(/[^\w-]/g, "")}.bin`);
	}

	#hasSecretFile(id: string): boolean {
		return existsSync(this.#secretFile(id));
	}

	#file(): string {
		return join(this.#options.dir, "mail-accounts.json");
	}

	#load(): Stored[] {
		try {
			const parsed = JSON.parse(readFileSync(this.#file(), "utf8")) as { accounts?: unknown };
			if (!Array.isArray(parsed.accounts)) return [];
			return parsed.accounts.filter(
				(item): item is Stored =>
					typeof item?.id === "string" && mailAccountProblem({ ...item, password: undefined }, true) === null,
			);
		} catch {
			return [];
		}
	}

	#write(): void {
		writeFileAtomicSync(this.#file(), JSON.stringify({ version: 1, accounts: this.#accounts }, null, 2), {
			mode: 0o600,
		});
		this.#options.onChange?.(this.state());
	}
}
