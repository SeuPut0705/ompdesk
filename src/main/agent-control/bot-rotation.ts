/**
 * The bot is a role, not one session (the owner's order, 2 Nov 2026: "The bot runs forever in ONE session"). Its
 * conversation, and each side chat's, is renewed: a fresh session file takes over, the old one is kept read-only under
 * the bot (`SessionInfo.bot` `past`) and deleted with its files `BOT_RETENTION_MS.pastConversation` after it ended,
 * however many there are (the promise the handoff and the owner were given: kept read-only for 7 days).
 *
 * When (`rotationReason`): the bot's own conversation at the first quiet moment after 04:00 local each day; any of
 * them once it auto-compacted `BOT_ROTATE_COMPACTIONS` times or its file passed `BOT_ROTATE_BYTES`; or when the owner
 * (the bot bar's New conversation) or the bot (`ompdesk_bot {"action":"new_conversation"}`) asked. Never in a turn
 * (a wait on its children included), with a question or approval open, while compacting, or while the owner has one
 * of its sessions taken over or is teaching it (`quiet`).
 *
 * How: the outgoing conversation is asked for a handoff note as a side question (stock `btw`, which never touches the
 * conversation; bounded), else a note is built from the desk, and a new session is made with the old one's title. Only
 * then is the old file held (`TurnGate`: every turn start on it waits), what went in before is let answer, and quiet
 * is checked again: a turn that started during the preparation wins, the unused file is deleted and nothing changed.
 * Under the hold `adopt` moves the live tab onto the new file (stock's switch aborts a running turn, so it must meet
 * none), takes the slot (pref `bot` for the bot), the wakes and mail aimed at the old file, and seeds the note; the
 * held turn starts go on once the hold opens, into the new conversation. The desk belongs to the role and is untouched.
 * State: pref `botConversations` (`BotConversations`).
 */
import {
	BOT_CONVERSATIONS_PREF,
	BOT_MAIN_SLOT,
	type BotConversation,
	type BotConversations,
	botConversationsOf,
} from "../../shared/agent-control";
import { BOT_RETENTION_MS, olderThan } from "../../shared/bot-retention";
import type { TurnGate } from "./turn-gate";

/** The conversation renews after this many automatic compactions. */
export const BOT_ROTATE_COMPACTIONS = 2;
/** The conversation renews once its file passes this size. */
export const BOT_ROTATE_BYTES = 2 * 1024 * 1024;
/** The daily renewal comes at the first quiet moment after this local hour. */
export const BOT_ROTATE_HOUR = 4;
/** How often main looks for a due renewal besides each turn's end (the daily one comes at a quiet moment). */
export const BOT_ROTATION_TICK_MS = 5 * 60_000;
/** How long the outgoing conversation has to write its handoff note. */
export const BOT_HANDOFF_TIMEOUT_MS = 120_000;

export type RotationReason = "owner" | "bot" | "daily" | "compacted" | "size";

/** The question the outgoing conversation answers on the side (`btw`): it never enters its transcript. */
export const BOT_HANDOFF_QUESTION =
	"OMPdesk is starting a fresh conversation for you now; this one ends. Write the handoff note your next conversation starts from: what you are doing, what you are waiting for, the next steps, and the id, title and state of every session you opened that is still open or unfinished. Facts only, at most 25 short lines, no tools.";

/** The latest daily boundary (`BOT_ROTATE_HOUR` local time) at or before `now`. */
export function lastBoundary(now: number): number {
	const at = new Date(now);
	at.setHours(BOT_ROTATE_HOUR, 0, 0, 0);
	if (at.getTime() > now) at.setDate(at.getDate() - 1);
	return at.getTime();
}

/** Why `conversation` should renew now, or null. Pure: the one place the triggers live. */
export function rotationReason(
	conversation: BotConversation,
	slot: string,
	now: number,
	bytes: number | undefined,
): RotationReason | null {
	if (conversation.requested) return conversation.requested;
	if (slot === BOT_MAIN_SLOT && conversation.startedAt < lastBoundary(now)) return "daily";
	if (conversation.compactions >= BOT_ROTATE_COMPACTIONS) return "compacted";
	if (bytes !== undefined && bytes > BOT_ROTATE_BYTES) return "size";
	return null;
}

export interface BotRotationDeps {
	prefs: { get(key: string): unknown; set(key: string, value: unknown): void };
	/** The slots' state or the bot's file moved: relist the sessions, tell the windows. */
	changed(): void;
	now(): number;
	/** The bot's conversations now, by slot (`BOT_MAIN_SLOT` and each side chat's id); empty while the bot is off. */
	slots(): { slot: string; path: string }[];
	/** When the session file began (its birth or header time); undefined when it is gone. */
	bornAt(path: string): number | undefined;
	bytes(path: string): number | undefined;
	/** No turn, no open question or approval, no compaction, no takeover or teaching (true with no live tab). */
	quiet(path: string): boolean;
	/** The live tab's side answer to `question`, or null (no live tab, a failure, `BOT_HANDOFF_TIMEOUT_MS` passed). */
	sideAnswer(path: string, question: string): Promise<string | null>;
	/** A note built from the desk: tasks in progress, children and their states, open decisions, wakes. */
	deskNote(slot: string): string;
	title(path: string): Promise<string>;
	/** Makes the next conversation's session file. */
	create(title: string): Promise<string>;
	/** Deletes a file `create` made that never took the slot (the renewal stopped). */
	discard(path: string): Promise<void>;
	/** What starts a turn waits here while a conversation renews. */
	gate: Pick<TurnGate, "hold" | "idle">;
	/**
	 * Puts `to` in `from`'s place, run while the gate holds `from`: the live tab (rejecting, having changed nothing, when
	 * it is not quiet or stock keeps `from`), then the slot's pref, wakes and mail, and the seeded note.
	 */
	adopt(input: { slot: string; from: string; to: string; note: string; reason: RotationReason }): Promise<void>;
	/** Deletes an ended conversation with its files; false keeps it for the next pass (a tab still runs it). */
	remove(path: string): Promise<boolean>;
	log(entry: Record<string, unknown>): void;
}

export class BotRotation {
	readonly #deps: BotRotationDeps;
	#running: Promise<void> | null = null;

	constructor(deps: BotRotationDeps) {
		this.#deps = deps;
	}

	#state(): BotConversations {
		return botConversationsOf(this.#deps.prefs.get(BOT_CONVERSATIONS_PREF));
	}

	#save(state: BotConversations): void {
		this.#deps.prefs.set(BOT_CONVERSATIONS_PREF, state);
		this.#deps.changed();
	}

	/**
	 * The slot's conversation as recorded, started over when the slot now names another file (the bot made a new
	 * session on its own, a side chat was added): its start is the file's own.
	 */
	#current(state: BotConversations, slot: string, path: string): BotConversation {
		const known = state.current[slot];
		if (known?.path === path) return known;
		return { path, startedAt: this.#deps.bornAt(path) ?? this.#deps.now(), compactions: 0 };
	}

	/** The owner or the bot asked for a new conversation of `slot`: it starts at the next quiet moment. */
	request(slot: string, by: "owner" | "bot"): boolean {
		const path = this.#deps.slots().find(entry => entry.slot === slot)?.path;
		if (!path) return false;
		const state = this.#state();
		state.current[slot] = { ...this.#current(state, slot, path), requested: by };
		this.#save(state);
		void this.tick();
		return true;
	}

	/** An automatic compaction in `path` produced a result. */
	compacted(path: string): void {
		const slot = this.#deps.slots().find(entry => entry.path === path);
		if (!slot) return;
		const state = this.#state();
		const conversation = this.#current(state, slot.slot, path);
		state.current[slot.slot] = { ...conversation, compactions: conversation.compactions + 1 };
		this.#save(state);
	}

	/** One pass: renew what is due and quiet, then age out ended conversations. One pass at a time. */
	tick(): Promise<void> {
		this.#running ??= this.#pass().finally(() => {
			this.#running = null;
		});
		return this.#running;
	}

	async #pass(): Promise<void> {
		for (const { slot, path } of this.#deps.slots()) {
			const state = this.#state();
			const conversation = this.#current(state, slot, path);
			if (state.current[slot]?.path !== path) {
				state.current[slot] = conversation;
				this.#save(state);
			}
			const reason = rotationReason(conversation, slot, this.#deps.now(), this.#deps.bytes(path));
			if (!reason || !this.#deps.quiet(path)) continue;
			try {
				await this.#rotate(slot, conversation, reason);
			} catch (error) {
				this.#deps.log({ event: "rotate-failed", slot, reason, error: String(error) });
			}
		}
		await this.#prune();
	}

	async #rotate(slot: string, conversation: BotConversation, reason: RotationReason): Promise<void> {
		const from = conversation.path;
		const answer = await this.#deps.sideAnswer(from, BOT_HANDOFF_QUESTION);
		const note = answer?.trim() ? answer.trim() : this.#deps.deskNote(slot);
		const to = await this.#deps.create(await this.#deps.title(from));
		const open = this.#deps.gate.hold(from);
		try {
			// What went in before the hold is answered first; a turn it or the preparation started wins.
			await this.#deps.gate.idle(from);
			if (!this.#deps.quiet(from)) {
				await this.#discard(to);
				this.#deps.log({ event: "rotate-deferred", slot, reason });
				return;
			}
			try {
				await this.#deps.adopt({ slot, from, to, note, reason });
			} catch (error) {
				await this.#discard(to);
				throw error;
			}
			const now = this.#deps.now();
			const state = this.#state();
			state.current[slot] = { path: to, startedAt: now, compactions: 0 };
			state.past = [
				...state.past.filter(entry => entry.path !== from),
				{ path: from, slot, startedAt: conversation.startedAt, endedAt: now },
			];
			this.#save(state);
		} finally {
			open();
		}
		this.#deps.log({ event: "rotated", slot, reason, from, to, handoff: answer?.trim() ? "asked" : "desk" });
	}

	async #discard(path: string): Promise<void> {
		try {
			await this.#deps.discard(path);
		} catch (error) {
			this.#deps.log({ event: "discard-failed", error: String(error) });
		}
	}

	/** Each ended conversation is deleted at its own `BOT_RETENTION_MS.pastConversation` mark; one a tab still runs waits. */
	async #prune(): Promise<void> {
		const now = this.#deps.now();
		const gone: string[] = [];
		for (const entry of this.#state().past) {
			if (!olderThan(entry.endedAt, BOT_RETENTION_MS.pastConversation, now)) continue;
			if (await this.#deps.remove(entry.path)) gone.push(entry.path);
		}
		if (gone.length === 0) return;
		const state = this.#state();
		state.past = state.past.filter(entry => !gone.includes(entry.path));
		this.#save(state);
		this.#deps.log({ event: "past-deleted", count: gone.length });
	}
}
