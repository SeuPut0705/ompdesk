/**
 * A message one session sends another (`ompdesk_session_send`) is a stock `prompt`; a receiver that is busy queues it
 * as a follow-up (or a steer) in its omp's memory and journals it only when its loop takes it. An omp that ends first
 * (OMPdesk relaunching for an update, a crash) loses it, and the sender was told "accepted; queued" (2 Nov 2026: an
 * orchestrating session's d2 to a worker never arrived after an update relaunch).
 *
 * So main keeps each message, per receiver session file (and paired device), until the receiver's journal holds its
 * marker (`[ompdesk dispatch d2:`, `[ompdesk request <id>]`). It remembers which omp process it handed the message to
 * (the bridge's `agent_control.sent` instance): that omp still holds it in its queue, so it is never sent there again;
 * a different omp (the one a relaunch started) has never seen it, and gets it once, in the order it was sent. An omp
 * that holds it no more while idle with nothing queued (the person or Autopilot withdrew the queue) lets it go.
 *
 * Kept in `<userData>/send-outbox.json` (written atomically when a message is handed over, never in a quit hook),
 * newest `SEND_OUTBOX_MAX`, none older than `SEND_OUTBOX_TTL_MS`.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../atomic-file";

export const SEND_OUTBOX_MAX = 200;
export const SEND_OUTBOX_TTL_MS = 3 * 24 * 60 * 60_000;

export interface OutboxSend {
	/** The marker the message carries: what the receiver's journal is asked for. */
	mark: string;
	/** The dispatch number of an opener's message to its child (`dN`), so a relaunch never numbers another one the same. */
	dispatch?: number;
	/** The receiver's session file (a paired device's own path when `device` is set). */
	sessionPath: string;
	device?: string;
	/** The sender's session file (its tab id when it has none): with `body`, how a repeated send is recognized. */
	from: string;
	/** What the sender wrote. */
	body: string;
	/** The prompt as sent: wrapped, with its markers. */
	message: string;
	streamingBehavior: "steer" | "followUp";
	/**
	 * The receiver omp it was handed to (`agent_control.sent`'s instance), or `tab:<tab id>` when that omp did not say
	 * who it is (a tab id names one tab of one launch). Absent: not handed to any omp yet.
	 */
	instance?: string;
	at: number;
}

/** What the receiver's bridge answers about markers (`agent_control_sent`). */
export interface SentAnswer {
	instance: string;
	journaled: string[];
}

/** A receiver session: its file on the computer it is saved on. */
export function receiverKey(sessionPath: string, device: string | undefined): string {
	return `${device ?? ""}\n${sessionPath}`;
}

function entryKey(entry: Pick<OutboxSend, "sessionPath" | "device" | "mark">): string {
	return `${receiverKey(entry.sessionPath, entry.device)}\n${entry.mark}`;
}

function parseEntry(value: unknown): OutboxSend | null {
	if (typeof value !== "object" || value === null) return null;
	const { mark, dispatch, sessionPath, device, from, body, message, streamingBehavior, instance, at } =
		value as Record<string, unknown>;
	if (typeof mark !== "string" || !mark || typeof sessionPath !== "string" || !sessionPath) return null;
	if (typeof from !== "string" || typeof body !== "string" || typeof message !== "string" || !message) return null;
	if (streamingBehavior !== "steer" && streamingBehavior !== "followUp") return null;
	if (typeof at !== "number") return null;
	return {
		mark,
		...(typeof dispatch === "number" && Number.isInteger(dispatch) ? { dispatch } : {}),
		sessionPath,
		...(typeof device === "string" && device ? { device } : {}),
		from,
		body,
		message,
		streamingBehavior,
		...(typeof instance === "string" && instance ? { instance } : {}),
		at,
	};
}

export class SendOutbox {
	readonly #file: string | null;
	readonly #now: () => number;
	readonly #entries = new Map<string, OutboxSend>();
	/** One delivery at a time per receiver session: a pass never sends again what a send is handing over. */
	readonly #lanes = new Map<string, Promise<unknown>>();

	constructor(file: string | null, now: () => number = Date.now) {
		this.#file = file;
		this.#now = now;
		if (!file) return;
		try {
			const value: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!Array.isArray(value)) return;
			for (const item of value) {
				const entry = parseEntry(item);
				if (entry) this.#entries.set(entryKey(entry), entry);
			}
		} catch {
			// No record yet, or a damaged one: nothing is owed as far as this launch knows.
		}
	}

	/** Keep a message about to be handed over (the same marker to the same receiver replaces its entry). */
	keep(entry: OutboxSend): void {
		const key = entryKey(entry);
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		this.#trim();
		this.#save();
	}

	/** The message is in the hands of the omp `instance` (it queues or runs it). */
	handed(entry: OutboxSend, instance: string): void {
		const kept = this.#entries.get(entryKey(entry));
		if (!kept || kept.instance === instance) return;
		kept.instance = instance;
		this.#save();
	}

	/** The receiver's journal holds it (or it will never be owed again): nothing more to do. */
	settle(entry: Pick<OutboxSend, "sessionPath" | "device" | "mark">): void {
		if (this.#entries.delete(entryKey(entry))) this.#save();
	}

	/** Every message still owed, oldest first. */
	pending(): OutboxSend[] {
		this.#trim();
		return [...this.#entries.values()];
	}

	/** The messages still owed to one receiver session, oldest first. */
	owedTo(sessionPath: string, device: string | undefined): OutboxSend[] {
		const key = receiverKey(sessionPath, device);
		return this.pending().filter(entry => receiverKey(entry.sessionPath, entry.device) === key);
	}

	/** The highest dispatch number still owed to a receiver (0: none), above which a new dispatch is numbered. */
	lastDispatch(sessionPath: string, device: string | undefined): number {
		return Math.max(0, ...this.owedTo(sessionPath, device).map(entry => entry.dispatch ?? 0));
	}

	/** The same message from the same sender, still owed to the receiver: a resend joins it. */
	waiting(from: string, sessionPath: string, device: string | undefined, body: string): OutboxSend | undefined {
		return this.owedTo(sessionPath, device).find(entry => entry.from === from && entry.body === body);
	}

	/** Run `work` alone for one receiver session (deliveries to it never overlap). */
	lane<T>(key: string, work: () => Promise<T>): Promise<T> {
		const before = this.#lanes.get(key) ?? Promise.resolve();
		const run = before.then(work, work);
		const tail = run.catch(() => undefined);
		this.#lanes.set(key, tail);
		void tail.then(() => {
			if (this.#lanes.get(key) === tail) this.#lanes.delete(key);
		});
		return run;
	}

	#trim(): void {
		const oldest = this.#now() - SEND_OUTBOX_TTL_MS;
		let changed = false;
		for (const [key, entry] of this.#entries)
			if (entry.at < oldest) {
				this.#entries.delete(key);
				changed = true;
			}
		while (this.#entries.size > SEND_OUTBOX_MAX) {
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
			console.warn(`[send-outbox] not saved: ${error}`);
		}
	}
}

/** How handing a prompt over went: taken (or queued behind a command still running there), or refused or unsent. */
export type HandOver = "handed" | "refused";

export interface OwedDeps {
	/** The live tab holding the receiver's session now (a new id after a relaunch); none while it is not open or starting. */
	tabOf: (sessionPath: string, device: string | undefined) => string | undefined;
	/** The receiver's bridge about the markers; null when it cannot be asked (starting, going away). */
	sent: (tabId: string, marks: string[]) => Promise<SentAnswer | null>;
	/** Hand the prompt to the receiver's omp. */
	prompt: (tabId: string, entry: OutboxSend) => Promise<HandOver>;
	/** The receiver's omp is idle with nothing queued: a message it held and did not journal was withdrawn. */
	drained: (tabId: string) => Promise<boolean>;
}

/**
 * Hand one receiver session what is still owed to it, in order: settle what its journal holds; leave what its current
 * omp already holds; send the rest to it (a relaunch's new omp) once. Stops at the first message it cannot hand over,
 * so a later one never overtakes it. Resolves true when nothing owed is left unhanded. Run inside the receiver's lane.
 */
export async function deliverOwed(
	outbox: SendOutbox,
	deps: OwedDeps,
	sessionPath: string,
	device: string | undefined,
): Promise<boolean> {
	const owed = outbox.owedTo(sessionPath, device);
	if (owed.length === 0) return true;
	const tabId = deps.tabOf(sessionPath, device);
	if (!tabId) return false;
	const answer = await deps
		.sent(
			tabId,
			owed.map(entry => entry.mark),
		)
		.catch(() => null);
	if (!answer) return false;
	let drained: boolean | undefined;
	for (const entry of owed) {
		if (answer.journaled.includes(entry.mark)) {
			outbox.settle(entry);
			continue;
		}
		if (entry.instance === answer.instance || entry.instance === `tab:${tabId}`) {
			outbox.handed(entry, answer.instance);
			// Its omp holds it no more and never journaled it: withdrawn from the queue, so a relaunch must not bring it back.
			drained ??= await deps.drained(tabId).catch(() => false);
			if (drained) outbox.settle(entry);
			continue;
		}
		if ((await deps.prompt(tabId, entry).catch((): HandOver => "refused")) === "refused") return false;
		outbox.handed(entry, answer.instance);
	}
	return true;
}

/** One pass over every receiver owed a message (the runtime's sweep). */
export async function redeliverSends(outbox: SendOutbox, deps: OwedDeps): Promise<void> {
	const receivers = new Map<string, { sessionPath: string; device: string | undefined }>();
	for (const entry of outbox.pending())
		receivers.set(receiverKey(entry.sessionPath, entry.device), {
			sessionPath: entry.sessionPath,
			device: entry.device,
		});
	for (const [key, { sessionPath, device }] of receivers)
		await outbox.lane(key, () => deliverOwed(outbox, deps, sessionPath, device)).catch(() => undefined);
}
