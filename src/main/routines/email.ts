/**
 * The email trigger of a routine: new mail in one of the owner's mailboxes (Settings › Schedules › Email accounts),
 * read over IMAP every `EMAIL_POLL_MINUTES` (`MailPort.read`, the IMAP client in imap.ts). No mail server of OMPdesk's
 * own and nothing reachable from the internet: this computer asks the owner's mail provider, as a mail app does.
 *
 * The first read only records where the mailbox stands (mail already there never fires, as for every trigger), and so
 * does the first read after the mailbox was recreated or the routine names another account. Then each new mail that
 * passes the routine's filters fires once, oldest first, with its sender, recipients, subject and the start of its
 * text. Loop guards, besides the service's own (`ROUTINE_CHAIN_LIMIT`): mail a program sent (`Auto-Submitted` other
 * than `no`) and a reply sent from this mailbox itself (its own address with `In-Reply-To`, as the bot's answer to a
 * mail would be) never fire.
 *
 * A failure (no such account, a refused login, the network) is told once per distinct message (the runtime log and a failed run in the routine's history),
 * never with the password, and polling goes on. The cursor (account, UIDVALIDITY, last UID) is kept across a relaunch
 * (`context.mark`), so mail that came while OMPdesk was closed fires once on the first read after it starts (the newest
 * `MESSAGES_PER_POLL` of them; older ones are passed over); the mark is saved before the routine fires.
 */
import { EMAIL_POLL_MINUTES } from "../../shared/schedules";
import type { MailboxRead, MailCursor, MailMessage } from "./imap";
import { clip, failureReporter, type RoutineSource, type SourceContext } from "./source";

export interface MailPort {
	/** The account an email routine names, by id or label (case aside); null when there is none. */
	account(name: string): { id: string; label: string; address: string } | null;
	/** One read of its mailbox past `cursor` (no cursor: the baseline). Rejects in words without the password. */
	read(accountId: string, cursor: MailCursor | null): Promise<MailboxRead>;
}

export interface EmailSourceOptions {
	account: string;
	from?: string;
	subject?: string;
	to?: string;
	mail: MailPort;
	context: SourceContext;
	/** Poll period (default `EMAIL_POLL_MINUTES`); only tests shorten it. */
	pollMs?: number;
}

const SNIPPET_CHARS = 600;
const FIELD_CHARS = 160;

export function createEmailSource(options: EmailSourceOptions): RoutineSource {
	return new EmailSource(options);
}

class EmailSource implements RoutineSource {
	readonly #options: EmailSourceOptions;
	readonly #report: (key: string, error: unknown | null) => void;
	#cursor: { accountId: string; cursor: MailCursor } | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;

	constructor(options: EmailSourceOptions) {
		this.#options = options;
		this.#report = failureReporter(message => options.context.warn(`email ${options.account}: ${message}`));
		const mark = options.context.mark as { accountId?: unknown; validity?: unknown; uid?: unknown } | undefined;
		if (typeof mark?.accountId === "string" && Number.isSafeInteger(mark.validity) && Number.isSafeInteger(mark.uid))
			this.#cursor = {
				accountId: mark.accountId,
				cursor: { validity: mark.validity as number, uid: mark.uid as number },
			};
		void this.#poll();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
	}

	async #poll(): Promise<void> {
		try {
			const account = this.#options.mail.account(this.#options.account);
			if (!account) throw new Error("no mail account has that name or id (Settings › Schedules › Email accounts)");
			const known = this.#cursor?.accountId === account.id ? this.#cursor.cursor : null;
			const read = await this.#options.mail.read(account.id, known);
			if (this.#stopped) return;
			this.#cursor = { accountId: account.id, cursor: read.cursor };
			this.#report("read", null);
			this.#options.context.saveMark({ accountId: account.id, ...read.cursor });
			if (known)
				for (const message of read.messages)
					if (this.#wanted(message, account.address)) this.#options.context.fire(describe(message, account.label));
		} catch (error) {
			if (this.#stopped) return;
			this.#report("read", error);
		}
		if (this.#stopped) return;
		this.#timer = setTimeout(() => void this.#poll(), this.#options.pollMs ?? EMAIL_POLL_MINUTES * 60_000);
		this.#timer.unref?.();
	}

	#wanted(message: MailMessage, ownAddress: string): boolean {
		const { headers } = message;
		const auto = (headers["auto-submitted"] ?? "").trim().toLowerCase();
		if (auto && auto !== "no") return false;
		const from = (headers.from ?? "").toLowerCase();
		const own = ownAddress.trim().toLowerCase();
		if (own && addresses(from).includes(own) && headers["in-reply-to"]) return false;
		const has = (text: string, needle: string | undefined) =>
			needle === undefined || text.toLowerCase().includes(needle.trim().toLowerCase());
		const recipients = [headers.to, headers.cc, headers["delivered-to"]].filter(Boolean).join(", ");
		return (
			has(headers.from ?? "", this.#options.from) &&
			has(headers.subject ?? "", this.#options.subject) &&
			has(recipients, this.#options.to)
		);
	}
}

/** The addresses in a header value, lower-cased. */
function addresses(value: string): string[] {
	return [...value.matchAll(/[^\s<>",;]+@[^\s<>",;]+/g)].map(match => match[0].toLowerCase());
}

function describe(message: MailMessage, label: string): string {
	const { headers } = message;
	const field = (name: string) => clip(headers[name] ?? "", FIELD_CHARS);
	const subject = field("subject") || "(no subject)";
	const text = clip(message.snippet, SNIPPET_CHARS);
	return `New mail in ${label} from ${field("from") || "an unknown sender"} to ${field("to") || "(no To)"}: "${subject}"${headers.date ? ` (${field("date")})` : ""}${text ? `. It begins: ${text}` : ""}`;
}
