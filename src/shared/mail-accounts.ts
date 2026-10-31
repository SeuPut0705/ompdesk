/**
 * Mailboxes the owner adds for email routines (Settings › Schedules › Email accounts): an IMAP server reached over TLS,
 * polled by this computer's email triggers (`src/main/routines/email.ts`). Main keeps them
 * (`src/main/mail-accounts.ts`): the account in `<userData>/mail-accounts.json`, its password encrypted with the OS
 * keystore (Electron `safeStorage`) beside it. A password goes one way: typed in Settings, sent to main once, never
 * read back by a window, an agent or a log. Each computer keeps its own (a paired host's are set on the host).
 */

export const MAIL_ACCOUNTS_COMMAND = "mail-accounts:command";

/** IMAP over TLS (implicit TLS, the usual port 993). */
export const MAIL_DEFAULT_PORT = 993;
export const MAIL_DEFAULT_MAILBOX = "INBOX";

export interface MailAccount {
	id: string;
	/** What the owner calls it; an email routine names its account by this label or by its id. */
	label: string;
	host: string;
	port: number;
	username: string;
	/** The folder polled, `INBOX` unless the owner chose another. */
	mailbox: string;
	/** Its address, for the loop guard (a reply sent from this mailbox never starts a routine); the username when it is one. */
	address: string;
	/** A password is stored (it is never sent back). */
	hasPassword: boolean;
}

export interface MailAccountDraft {
	label: string;
	host: string;
	port: number;
	username: string;
	mailbox: string;
	/** Absent (or empty) on an edit: the stored password is kept. */
	password?: string;
}

export type MailAccountsRequest =
	| { action: "list" }
	| { action: "save"; id?: string; draft: MailAccountDraft }
	| { action: "remove"; id: string }
	/** Log in and open the mailbox once, the way a poll does. */
	| { action: "test"; id: string };

export interface MailAccountsState {
	accounts: MailAccount[];
}

/** `test`'s answer: the mailbox opened (with how many messages it holds), or the server's or the network's reason. */
export type MailAccountTest = { ok: true; messages: number } | { ok: false; error: string };

export interface MailAccountsApi {
	command(request: Exclude<MailAccountsRequest, { action: "test" }>): Promise<MailAccountsState>;
	test(id: string): Promise<MailAccountTest>;
}

const HOST = /^[A-Za-z0-9.-]+$/;

/** Why a draft cannot be saved, as a locale key suffix; null when it can. `editing`: an account that has a password. */
export function mailAccountProblem(
	draft: MailAccountDraft,
	editing: boolean,
): "label" | "host" | "port" | "username" | "mailbox" | "password" | null {
	if (!draft.label.trim() || draft.label.length > 60) return "label";
	if (!HOST.test(draft.host.trim()) || draft.host.length > 253) return "host";
	if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65_535) return "port";
	if (!draft.username.trim() || draft.username.length > 320 || /[\r\n]/.test(draft.username)) return "username";
	if (!draft.mailbox.trim() || draft.mailbox.length > 200 || /[\r\n]/.test(draft.mailbox)) return "mailbox";
	const password = draft.password ?? "";
	if (/[\r\n]/.test(password) || password.length > 1000) return "password";
	if (!editing && !password) return "password";
	return null;
}
