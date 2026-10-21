/**
 * Sessions tell each other things (the mailbox): an opened session reports to the session that opened it
 * (`ompdesk_report`), and siblings of one opener can write to each other, instead of the opener polling.
 * The idea is Orca's orchestration mailbox (worker_done / heartbeat / escalation verbs, decision gates routed to the
 * parent and never auto-resolved, dispatch ids so a stale message cannot complete a retry), rebuilt on stock's own
 * custom messages: a report lands in the receiver's session as one `ompdesk.mail` custom message (journaled by stock,
 * so a relaunch neither loses nor repeats it), delivered as stock's `aside`: a busy receiver reads it at its next step
 * boundary without its tool batch being cut, and an interruptible `wait` returns on it.
 *
 *   question, blocked,  `aside` + `triggerTurn`: an idle receiver starts a turn on it. A question or blocker is
 *   done, review        answered with `ompdesk_session_send` or by the user; nothing answers it on its own.
 *   progress, note      no turn (`triggerTurn: false`): shown at once when the receiver is idle; while a turn runs the
 *                       receiver's bridge sends it as an `aside` too, so the model reads it between its steps;
 *                       progress from one sender is coalesced, the latest wins.
 *
 * Pure rules; the timers and delivery are injected (`host.ts` sends the mail through the receiver's omp).
 */

export const MAIL_KINDS = ["progress", "done", "blocked", "question", "review", "note"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];
export { MAIL_CUSTOM_TYPE } from "../../../resources/gui-bridge/agent-control-contracts";

/** Progress from one sender to one receiver within this window is delivered once, the latest text. */
export const MAIL_COALESCE_MS = 2_000;
/** A coalesced progress report whose delivery failed is tried this many more times. */
export const MAIL_PROGRESS_RETRIES = 3;

export interface MailCheck {
	command: string;
	passed: boolean;
}

export interface Mail {
	/** Unique per report (idempotency of a retried tool call). */
	id: string;
	from: string;
	fromTitle: string;
	to: string;
	kind: MailKind;
	text: string;
	files?: string[];
	checks?: MailCheck[];
	/** The dispatch the sender worked on (the opener's message it answers). */
	dispatch?: string;
	/** Progress reports this one stands for (coalesced). */
	merged?: number;
	/** The child's own question card (an extension UI request id) this mail announces, not a report it wrote. */
	card?: string;
	at: number;
}

export interface MailDelivery {
	triggerTurn: boolean;
	deliverAs?: "aside";
}

/** How stock delivers a report of this kind (a no-turn one becomes an `aside` in the receiver's bridge while a turn runs). */
export function deliveryFor(kind: MailKind): MailDelivery {
	switch (kind) {
		case "question":
		case "blocked":
		case "done":
		case "review":
			return { triggerTurn: true, deliverAs: "aside" };
		default:
			return { triggerTurn: false };
	}
}

const KIND_LABEL: Record<MailKind, string> = {
	progress: "progress",
	done: "done",
	blocked: "blocked",
	question: "question",
	review: "needs review",
	note: "note",
};

/** What the receiving model reads (the transcript draws `details` instead). */
export function mailText(mail: Mail): string {
	const lines = [
		`<ompdesk-mail from="${mail.from}" title="${mail.fromTitle.replace(/"/g, "'")}" kind="${mail.kind}"${mail.dispatch ? ` dispatch="${mail.dispatch}"` : ""}>`,
		mail.text,
	];
	if (mail.files?.length) lines.push(`changed files: ${mail.files.join(", ")}`);
	if (mail.checks?.length)
		lines.push(
			`checks: ${mail.checks.map(check => `${check.command} ${check.passed ? "passed" : "FAILED"}`).join("; ")}`,
		);
	if (mail.merged) lines.push(`(latest of ${mail.merged + 1} progress reports)`);
	lines.push("</ompdesk-mail>");
	if (mail.card)
		lines.push(
			`Session ${mail.from} shows this question card and waits (request ${mail.card}). When the answer is yours to give within its task, answer it with ompdesk_session_answer (the field named above); when only the user can decide, tell the user. Never guess an approval.`,
		);
	else if (mail.kind === "question" || mail.kind === "blocked")
		lines.push(
			`Session ${mail.from} waits on you. Answer it with ompdesk_session_send, or ask the user when only they can decide; never guess an approval.`,
		);
	else if (mail.kind === "done" || mail.kind === "review")
		lines.push(
			`Judge it against the acceptance you gave (ompdesk_compare, ompdesk_session_read), then merge or reply.`,
		);
	return lines.join("\n");
}

/** The quiet transcript line's data. */
export function mailDetails(mail: Mail): Record<string, unknown> {
	return {
		id: mail.id,
		from: mail.from,
		fromTitle: mail.fromTitle,
		kind: mail.kind,
		label: KIND_LABEL[mail.kind],
		text: mail.text,
		...(mail.files?.length ? { files: mail.files } : {}),
		...(mail.checks?.length ? { checks: mail.checks } : {}),
		...(mail.dispatch ? { dispatch: mail.dispatch } : {}),
		...(mail.merged ? { merged: mail.merged } : {}),
	};
}

export interface MailboxDeps {
	now: () => number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (timer: unknown) => void;
	/** Deliver one mail into its receiver's session. */
	deliver: (mail: Mail) => Promise<void>;
}

/** A sender's last report to one receiver, and whether its question still waits on that receiver. */
export interface MailState {
	last: Mail;
	/** A question or blocked report this receiver has not answered (sent the sender new work) since. */
	waiting: boolean;
}

/**
 * Per sender: the dispatch it currently works on, and per receiver its last report and whether a question waits on
 * that receiver. Coalesces progress, drops a report from a superseded dispatch, delivers each report id once.
 */
export class Mailbox {
	readonly #deps: MailboxDeps;
	readonly #dispatch = new Map<string, { n: number; id: string }>();
	/** Keyed `from>to`: a question to a sibling waits on the sibling, never on the opener's board. */
	readonly #state = new Map<string, MailState>();
	readonly #seen = new Set<string>();
	readonly #pending = new Map<string, { mail: Mail; timer: unknown }>();

	constructor(deps: MailboxDeps) {
		this.#deps = deps;
	}

	/** The opener gave `child` new work: a new dispatch id, and its waiting question counts as answered. */
	dispatch(child: string): string {
		const n = (this.#dispatch.get(child)?.n ?? 0) + 1;
		const id = `d${n}`;
		this.#dispatch.set(child, { n, id });
		for (const [key, state] of this.#state) if (key.startsWith(`${child}>`)) state.waiting = false;
		return id;
	}

	current(child: string): string | undefined {
		return this.#dispatch.get(child)?.id;
	}

	/** Whether this launch knows `child`'s dispatch (else main reads it back from the child's journal). */
	knows(child: string): boolean {
		return this.#dispatch.has(child);
	}

	/**
	 * The dispatch number the child's own journal names (the last `[ompdesk dispatch dN` its opener's messages carried),
	 * so a relaunch keeps fencing stale reports and numbers the next dispatch after it. Never lowers a known one.
	 */
	seed(child: string, n: number): void {
		if (n > (this.#dispatch.get(child)?.n ?? 0)) this.#dispatch.set(child, { n, id: `d${n}` });
	}

	/** `child`'s last report to `receiver`. */
	state(child: string, receiver: string): MailState | undefined {
		return this.#state.get(`${child}>${receiver}`);
	}

	/**
	 * Accept a report; resolves with what the sender is told. A repeated id is a no-op ("already delivered"); a
	 * report naming an older dispatch than the sender's current one is ignored ("stale").
	 */
	async post(mail: Mail): Promise<"delivered" | "queued" | "duplicate" | "stale"> {
		if (this.#seen.has(mail.id)) return "duplicate";
		const current = this.#dispatch.get(mail.from)?.id;
		if (mail.dispatch && current && mail.dispatch !== current) return "stale";
		// Marked seen only once delivered: a delivery that failed (the receiver's omp restarting, a paired device's link
		// down) leaves the id free, so the sender's retry with the same id goes through.
		const stamped = { ...mail, ...(current ? { dispatch: current } : {}) };
		const key = `${mail.from}>${mail.to}`;
		this.#state.set(key, {
			last: stamped,
			waiting: mail.kind === "question" || mail.kind === "blocked",
		});
		const pending = this.#pending.get(key);
		if (mail.kind === "progress") {
			const merged = pending ? (pending.mail.merged ?? 0) + 1 : 0;
			if (pending) this.#deps.clearTimer(pending.timer);
			const next = { ...stamped, ...(merged ? { merged } : {}) };
			const flush = (attempt: number): void => {
				this.#pending.delete(key);
				this.#deps.deliver(next).then(
					() => this.#seen.add(next.id),
					() => {
						// One failed delivery is retried a few times, unless newer progress replaced it meanwhile.
						if (attempt >= MAIL_PROGRESS_RETRIES || this.#pending.has(key)) return;
						this.#pending.set(key, {
							mail: next,
							timer: this.#deps.setTimer(() => flush(attempt + 1), MAIL_COALESCE_MS),
						});
					},
				);
			};
			const timer = this.#deps.setTimer(() => flush(0), MAIL_COALESCE_MS);
			this.#pending.set(key, { mail: next, timer });
			return "queued";
		}
		// Anything else supersedes the progress still waiting from the same sender.
		if (pending) {
			this.#deps.clearTimer(pending.timer);
			this.#pending.delete(key);
		}
		await this.#deps.deliver(stamped);
		this.#seen.add(mail.id);
		return "delivered";
	}

	/** A closed session leaves nothing behind. */
	forget(tab: string): void {
		this.#dispatch.delete(tab);
		for (const key of this.#state.keys())
			if (key.startsWith(`${tab}>`) || key.endsWith(`>${tab}`)) this.#state.delete(key);
		for (const [key, pending] of this.#pending)
			if (key.startsWith(`${tab}>`) || key.endsWith(`>${tab}`)) {
				this.#deps.clearTimer(pending.timer);
				this.#pending.delete(key);
			}
	}
}
