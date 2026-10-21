/**
 * A report reaches a busy receiver as a stock `aside`: stock queues it in memory and journals it at the receiver's next
 * step boundary (or when a quit disposes the session). An omp that is killed first (a crash, a force-quit of OMPdesk)
 * loses it, and nothing sent it again (21 Oct 2026: a child's `done` to a parent inside a long tool call was lost
 * across an update restart; measured on the installed omp in `bridge-agent-mail-restart-stock.test.ts`).
 *
 * So main keeps each accepted report, per receiver session file (and paired device), until the receiver's journal holds
 * its id. Every pass asks the receiver's current omp again with the same id: its bridge answers `{duplicate, journaled}`
 * for an id it holds or queued and delivers one it has never seen, so an omp that replaced the one that was killed gets
 * the report exactly once, and an omp that still queues it is left alone.
 *
 * Kept in `<userData>/mail-outbox.json` (written atomically, newest `MAIL_OUTBOX_MAX`, none older than
 * `MAIL_OUTBOX_TTL_MS`): the file is written when a report is accepted, never in a quit hook, so a crash loses nothing.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../atomic-file";
import type { MailDelivery } from "./mail";

export const MAIL_OUTBOX_MAX = 100;
export const MAIL_OUTBOX_TTL_MS = 3 * 24 * 60 * 60_000;

export interface OutboxMail {
	/** The report's id (`details.id`): the key, and what the receiver's journal is asked for. */
	id: string;
	/** The receiver's session file (a paired device's own path when `device` is set). */
	sessionPath: string;
	device?: string;
	content: string;
	details: Record<string, unknown>;
	delivery: MailDelivery;
	at: number;
}

function parseEntry(value: unknown): OutboxMail | null {
	if (typeof value !== "object" || value === null) return null;
	const { id, sessionPath, device, content, details, delivery, at } = value as Record<string, unknown>;
	if (typeof id !== "string" || !id || typeof sessionPath !== "string" || !sessionPath) return null;
	if (typeof content !== "string" || typeof details !== "object" || details === null) return null;
	if (typeof delivery !== "object" || delivery === null || typeof at !== "number") return null;
	const { triggerTurn, deliverAs } = delivery as Record<string, unknown>;
	if (typeof triggerTurn !== "boolean") return null;
	// `followUp`: what an earlier build kept; reports are asides now, and the bridge sends it as one.
	if (deliverAs !== undefined && deliverAs !== "aside" && deliverAs !== "followUp") return null;
	return {
		id,
		sessionPath,
		...(typeof device === "string" && device ? { device } : {}),
		content,
		details: details as Record<string, unknown>,
		delivery: { triggerTurn, ...(deliverAs ? { deliverAs: "aside" as const } : {}) },
		at,
	};
}

export class MailOutbox {
	readonly #file: string | null;
	readonly #now: () => number;
	readonly #entries = new Map<string, OutboxMail>();

	constructor(file: string | null, now: () => number = Date.now) {
		this.#file = file;
		this.#now = now;
		if (!file) return;
		try {
			const value: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!Array.isArray(value)) return;
			for (const item of value) {
				const entry = parseEntry(item);
				if (entry) this.#entries.set(entry.id, entry);
			}
		} catch {
			// No record yet, or a damaged one: nothing is waiting as far as this launch knows.
		}
	}

	/** Keep an accepted report (the same id replaces its entry). */
	keep(entry: OutboxMail): void {
		this.#entries.delete(entry.id);
		this.#entries.set(entry.id, entry);
		this.#trim();
		this.#save();
	}

	/** The receiver's journal holds `id`: nothing more to do for it. */
	settle(id: string): void {
		if (this.#entries.delete(id)) this.#save();
	}

	/** The reports still waiting for their receiver's journal, oldest first; one past its age is dropped. */
	pending(): OutboxMail[] {
		this.#trim();
		return [...this.#entries.values()];
	}

	#trim(): void {
		const oldest = this.#now() - MAIL_OUTBOX_TTL_MS;
		let changed = false;
		for (const [id, entry] of this.#entries)
			if (entry.at < oldest) {
				this.#entries.delete(id);
				changed = true;
			}
		while (this.#entries.size > MAIL_OUTBOX_MAX) {
			const first = this.#entries.keys().next().value;
			if (first === undefined) break;
			this.#entries.delete(first);
			changed = true;
		}
		if (changed) this.#save();
	}

	#save(): void {
		if (!this.#file) return;
		try {
			writeFileAtomicSync(this.#file, JSON.stringify([...this.#entries.values()]), { mode: 0o600 });
		} catch (error) {
			console.warn(`[mail-outbox] not saved: ${error}`);
		}
	}
}

export interface RedeliverDeps {
	/** The live tab holding the receiver's session file now (it has a new id after a relaunch), if any. */
	tabOf: (sessionPath: string, device?: string) => string | undefined;
	/** The receiver's bridge answer to the report (`agent_control_mail`); rejects when it could not be asked. */
	send: (tabId: string, mail: OutboxMail) => Promise<{ duplicate?: boolean; journaled?: boolean } | undefined>;
}

/**
 * One pass over the outbox: each report whose receiver has a live tab is sent again with its id. An answer that says
 * the journal holds it settles it; any other answer (delivered just now, queued by this omp, no answer) keeps it for
 * the next pass, and a receiver nobody has opened yet is left until its tab exists.
 */
export async function redeliverMail(outbox: MailOutbox, deps: RedeliverDeps): Promise<void> {
	for (const mail of outbox.pending()) {
		const tabId = deps.tabOf(mail.sessionPath, mail.device);
		if (!tabId) continue;
		try {
			const answer = await deps.send(tabId, mail);
			if (answer?.duplicate === true && answer.journaled === true) outbox.settle(mail.id);
		} catch {
			// The receiver's omp is starting or going away: the next pass asks again.
		}
	}
}
