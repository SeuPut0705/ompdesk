/**
 * The small IMAP client an email routine polls with (RFC 9051/3501 subset): over one TLS connection it logs in, opens
 * the mailbox read-only (`EXAMINE`), lists the UIDs past a cursor (`UID SEARCH`), reads their headers and the start of
 * their text (`UID FETCH … BODY.PEEK`, so nothing is marked read) and logs out. Written here instead of a package: four
 * commands, no state between polls, and a fake server tests it end to end (`fake-imap.ts`).
 *
 * The password goes into the LOGIN command and nowhere else: no error, log line or result carries it.
 */
import type { Duplex } from "node:stream";

/** One poll of a mailbox: everything a connection needs and nothing kept after it. */
export interface ImapLogin {
	username: string;
	password: string;
	mailbox: string;
}

/** Where the mailbox stands: a UID past `uid` is new, unless `validity` changed (then the UIDs mean other mail). */
export interface MailCursor {
	validity: number;
	uid: number;
}

export interface MailMessage {
	uid: number;
	/** Header fields, lower-cased names, RFC 2047 words decoded, folded lines joined. */
	headers: Record<string, string>;
	/** The start of its plain text (a text/plain part's when it has one), decoded, at most `SNIPPET_CHARS`. */
	snippet: string;
}

export interface MailboxRead {
	cursor: MailCursor;
	/** Mail past the cursor, oldest first (none when there was no cursor: that read is the baseline). */
	messages: MailMessage[];
	/** How many messages the mailbox holds (`EXISTS`). */
	exists: number;
}

/** A connected socket to the server (TLS in production, plain TCP in the tests' fake server). */
export type ImapConnect = () => Promise<Duplex>;

const TIMEOUT_MS = 30_000;
/** Messages read per poll; more new ones than this fire only the newest. */
export const MESSAGES_PER_POLL = 20;
const BODY_BYTES = 6_000;
export const SNIPPET_CHARS = 1_000;
const HEADER_FIELDS = [
	"FROM",
	"TO",
	"CC",
	"DELIVERED-TO",
	"SUBJECT",
	"DATE",
	"MESSAGE-ID",
	"IN-REPLY-TO",
	"AUTO-SUBMITTED",
	"CONTENT-TYPE",
	"CONTENT-TRANSFER-ENCODING",
];

/** A server's refusal or a broken exchange, in words that never hold the password. */
export class ImapError extends Error {}

/**
 * One read of the mailbox. Without a cursor (or after the mailbox's UIDVALIDITY changed) it only records where the
 * mailbox stands; with one it returns the mail past it.
 */
export async function readMailbox(
	connect: ImapConnect,
	login: ImapLogin,
	cursor: MailCursor | null,
	timeoutMs = TIMEOUT_MS,
): Promise<MailboxRead> {
	const session = new Session(await connect(), timeoutMs);
	try {
		await session.greeting();
		await session.command(`LOGIN ${quote(login.username)} ${quote(login.password)}`, "login");
		const opened = await session.command(`EXAMINE ${quote(login.mailbox)}`, "open the mailbox");
		const validity = codeNumber(opened, "UIDVALIDITY");
		const next = codeNumber(opened, "UIDNEXT");
		const exists = untaggedNumber(opened, "EXISTS") ?? 0;
		if (validity === null) throw new ImapError("the server named no UIDVALIDITY for the mailbox");
		let last = next !== null ? next - 1 : 0;
		if (next === null) {
			// A server that names no UIDNEXT: the newest UID is the mailbox's own.
			const all = searchUids(await session.command("UID SEARCH ALL", "list the mailbox"));
			last = all.length > 0 ? Math.max(...all) : 0;
		}
		if (!cursor || cursor.validity !== validity) {
			await session.logout();
			return { cursor: { validity, uid: last }, messages: [], exists };
		}
		const fresh = searchUids(await session.command(`UID SEARCH UID ${cursor.uid + 1}:*`, "look for new mail"))
			.filter(uid => uid > cursor.uid)
			.toSorted((a, b) => a - b);
		const wanted = fresh.slice(-MESSAGES_PER_POLL);
		const messages: MailMessage[] = [];
		if (wanted.length > 0) {
			const fetched = await session.command(
				`UID FETCH ${wanted.join(",")} (UID BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS.join(" ")})] BODY.PEEK[TEXT]<0.${BODY_BYTES}>)`,
				"read the new mail",
			);
			for (const message of parseFetch(fetched)) messages.push(message);
		}
		await session.logout();
		const newest = Math.max(cursor.uid, ...fresh);
		return {
			cursor: { validity, uid: newest },
			messages: messages.toSorted((a, b) => a.uid - b.uid),
			exists,
		};
	} finally {
		session.close();
	}
}

/** A quoted IMAP string; CR and LF cannot be quoted and are refused before anything is sent. */
function quote(value: string): string {
	if (/[\r\n]/.test(value)) throw new ImapError("a login value or mailbox holds a line break");
	return `"${value.replace(/[\\"]/g, match => `\\${match}`)}"`;
}

/** One response line, with the literals (`{n}` then n bytes) it carries spliced into `literals`. */
interface Line {
	text: string;
	literals: Buffer[];
}

class Session {
	readonly #socket: Duplex;
	readonly #timeoutMs: number;
	#buffer = Buffer.alloc(0);
	#waiting: (() => void) | null = null;
	#failure: Error | null = null;
	#tag = 0;

	constructor(socket: Duplex, timeoutMs: number) {
		this.#socket = socket;
		this.#timeoutMs = timeoutMs;
		socket.on("data", (chunk: Buffer) => {
			this.#buffer = Buffer.concat([this.#buffer, chunk]);
			this.#wake();
		});
		socket.on("error", (error: Error) => {
			this.#failure = new ImapError(`the connection failed: ${error.message}`);
			this.#wake();
		});
		socket.on("close", () => {
			this.#failure ??= new ImapError("the server closed the connection");
			this.#wake();
		});
	}

	async greeting(): Promise<void> {
		const line = await this.#line();
		if (/^\* BYE/i.test(line.text)) throw new ImapError(`the server refused: ${line.text.slice(6)}`);
		if (!/^\* (OK|PREAUTH)/i.test(line.text)) throw new ImapError("the server did not greet as IMAP");
	}

	/** Sends one command and collects its untagged lines; a NO or BAD fails it with the server's words. */
	async command(command: string, what: string): Promise<Line[]> {
		const tag = `A${++this.#tag}`;
		this.#socket.write(`${tag} ${command}\r\n`);
		const lines: Line[] = [];
		for (;;) {
			const line = await this.#line();
			if (line.text.startsWith(`${tag} `)) {
				const rest = line.text.slice(tag.length + 1);
				if (/^OK\b/i.test(rest)) return lines;
				throw new ImapError(`could not ${what}: ${rest.replace(/^(NO|BAD)\s*/i, "") || rest}`);
			}
			if (line.text.startsWith("+")) throw new ImapError(`could not ${what}: the server asked for more`);
			lines.push(line);
		}
	}

	async logout(): Promise<void> {
		await this.command("LOGOUT", "log out").catch(() => undefined);
	}

	close(): void {
		this.#socket.destroy();
	}

	#wake(): void {
		const waiting = this.#waiting;
		this.#waiting = null;
		waiting?.();
	}

	async #wait(): Promise<void> {
		if (this.#failure) throw this.#failure;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => reject(new ImapError("the server did not answer in time")), this.#timeoutMs);
		this.#waiting = () => {
			clearTimeout(timer);
			resolve();
		};
		await promise;
		if (this.#failure && this.#buffer.length === 0) throw this.#failure;
	}

	/** The next whole line, its literals read in full. */
	async #line(): Promise<Line> {
		let text = "";
		const literals: Buffer[] = [];
		for (;;) {
			const end = this.#buffer.indexOf("\r\n");
			if (end === -1) {
				await this.#wait();
				continue;
			}
			const part = this.#buffer.subarray(0, end).toString("utf8");
			const literal = /\{(\d+)\}$/.exec(part);
			if (!literal) {
				this.#buffer = this.#buffer.subarray(end + 2);
				return { text: text + part, literals };
			}
			const size = Number(literal[1]);
			while (this.#buffer.length < end + 2 + size) await this.#wait();
			literals.push(Buffer.from(this.#buffer.subarray(end + 2, end + 2 + size)));
			text += `${part.slice(0, literal.index)}\u0000${literals.length - 1}\u0000`;
			this.#buffer = this.#buffer.subarray(end + 2 + size);
		}
	}
}

function codeNumber(lines: readonly Line[], code: string): number | null {
	for (const { text } of lines) {
		const match = new RegExp(`\\[${code} (\\d+)\\]`, "i").exec(text);
		if (match) return Number(match[1]);
	}
	return null;
}

function untaggedNumber(lines: readonly Line[], word: string): number | null {
	for (const { text } of lines) {
		const match = new RegExp(`^\\* (\\d+) ${word}\\b`, "i").exec(text);
		if (match) return Number(match[1]);
	}
	return null;
}

function searchUids(lines: readonly Line[]): number[] {
	const uids: number[] = [];
	for (const { text } of lines) {
		const match = /^\* SEARCH\b(.*)$/i.exec(text);
		if (!match) continue;
		for (const word of (match[1] ?? "").trim().split(/\s+/)) if (/^\d+$/.test(word)) uids.push(Number(word));
	}
	return uids;
}

/** `* n FETCH (UID u BODY[HEADER.FIELDS (…)] {a}… BODY[TEXT]<0> {b}…)` lines as messages. */
function parseFetch(lines: readonly Line[]): MailMessage[] {
	const messages: MailMessage[] = [];
	for (const { text, literals } of lines) {
		if (!/^\* \d+ FETCH /i.test(text)) continue;
		const uid = Number(/\bUID (\d+)/i.exec(text)?.[1]);
		if (!Number.isFinite(uid)) continue;
		const literalAfter = (marker: RegExp): Buffer | null => {
			const match = marker.exec(text);
			if (!match) return null;
			const index = /\u0000(\d+)\u0000/.exec(text.slice(match.index))?.[1];
			return index === undefined ? null : (literals[Number(index)] ?? null);
		};
		const headers = parseHeaders((literalAfter(/BODY\[HEADER\.FIELDS/i) ?? Buffer.alloc(0)).toString("latin1"));
		const body = literalAfter(/BODY\[TEXT\]/i) ?? Buffer.alloc(0);
		messages.push({ uid, headers, snippet: snippetOf(headers, body) });
	}
	return messages;
}

/** Header lines to a record: folded lines joined, names lower-cased, encoded words decoded. */
export function parseHeaders(raw: string): Record<string, string> {
	const headers: Record<string, string> = {};
	const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
	for (const line of unfolded.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		const value = decodeWords(Buffer.from(line.slice(colon + 1).trim(), "latin1").toString("utf8"));
		headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
	}
	return headers;
}

/** RFC 2047 encoded words (`=?utf-8?B?…?=`, `=?…?Q?…?=`), adjacent ones joined without the space between. */
export function decodeWords(value: string): string {
	return value
		.replace(/(\?=)\s+(=\?)/g, "$1$2")
		.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, kind: string, text: string) => {
			try {
				const bytes =
					kind.toUpperCase() === "B" ? Buffer.from(text, "base64") : quotedPrintable(text.replace(/_/g, " "));
				return new TextDecoder(charset.toLowerCase()).decode(bytes);
			} catch {
				return whole;
			}
		});
}

function quotedPrintable(text: string): Buffer {
	const bytes: number[] = [];
	const source = text.replace(/=\r?\n/g, "");
	for (let index = 0; index < source.length; index++) {
		const char = source[index] as string;
		const hex = source.slice(index + 1, index + 3);
		if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			index += 2;
		} else bytes.push(...Buffer.from(char, "latin1"));
	}
	return Buffer.from(bytes);
}

function decodeBody(body: Buffer, encoding: string, charset: string): string {
	const kind = encoding.trim().toLowerCase();
	let bytes = body;
	if (kind === "base64") {
		// The read stops at `BODY_BYTES`: only whole groups of four decode.
		const clean = body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
		bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64");
	} else if (kind === "quoted-printable") bytes = quotedPrintable(body.toString("latin1"));
	try {
		return new TextDecoder(charset || "utf-8").decode(bytes);
	} catch {
		return bytes.toString("utf8");
	}
}

function parameter(contentType: string, name: string): string {
	return new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i").exec(contentType)?.[1]?.trim() ?? "";
}

/** The start of the message's plain text: its own body, or the first text/plain (else text/*) part of a multipart. */
function snippetOf(headers: Record<string, string>, body: Buffer): string {
	const type = headers["content-type"] ?? "text/plain";
	let text: string;
	if (/^\s*multipart\//i.test(type)) {
		const boundary = parameter(type, "boundary");
		text = boundary ? partText(body.toString("latin1"), boundary) : "";
	} else text = decodeBody(body, headers["content-transfer-encoding"] ?? "", parameter(type, "charset"));
	if (/^\s*text\/html/i.test(type)) text = stripHtml(text);
	const flat = text.replace(/\s+/g, " ").trim();
	return [...flat].slice(0, SNIPPET_CHARS).join("");
}

function partText(raw: string, boundary: string): string {
	const parts = raw.split(`--${boundary}`).slice(1);
	const read = (part: string) => {
		const split = part.search(/\r?\n\r?\n/);
		if (split === -1) return null;
		const headers = parseHeaders(part.slice(0, split));
		const body = Buffer.from(part.slice(split).replace(/^\r?\n\r?\n/, ""), "latin1");
		return { headers, body };
	};
	const parsed = parts.map(read).filter(part => part !== null);
	const plain = parsed.find(part => /^\s*text\/plain/i.test(part.headers["content-type"] ?? "text/plain"));
	const pick = plain ?? parsed.find(part => /^\s*text\//i.test(part.headers["content-type"] ?? ""));
	if (!pick) return "";
	const type = pick.headers["content-type"] ?? "text/plain";
	const text = decodeBody(pick.body, pick.headers["content-transfer-encoding"] ?? "", parameter(type, "charset"));
	return /^\s*text\/html/i.test(type) ? stripHtml(text) : text;
}

function stripHtml(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}
