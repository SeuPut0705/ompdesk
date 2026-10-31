/**
 * The bot's desk (`shared/bot-desk.ts`): its standing duties, the decisions it posted for the owner, its identity,
 * memories, notice routing, voice and side chats, in `<userData>/bot-desk.json`. Main alone writes it: the bot through
 * `ompdesk_bot`, the owner through the IPC handlers in `ipc.ts`. Every change is written (atomically) before it is
 * kept and heard, so what a window reads is what a relaunch finds. A file that cannot be read is an empty desk.
 * Every change is also told to the activity log (`activity`), with the edit that takes it back where one can.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ZodType, ZodTypeDef } from "zod";
import type { BotActivityDraft } from "../../shared/bot-activity";
import {
	BOT_CHANNELS_MAX,
	BOT_DECISION_OPTIONS_MAX,
	BOT_DECISIONS_ANSWERED_KEPT,
	BOT_DUTIES_MAX,
	BOT_MEMORIES_MAX,
	type BotChannel,
	BotChannelSchema,
	type BotDecision,
	BotDecisionSchema,
	type BotDeskChange,
	type BotDeskDuties,
	type BotDeskEdit,
	type BotDeskFile,
	type BotDeskState,
	type BotDuty,
	BotDutySchema,
	BotIdentitySchema,
	type BotMemory,
	BotMemorySchema,
	BotNotifySchema,
	BotVoiceSchema,
	type BotWake,
	botDutiesText,
	EMPTY_BOT_DESK_FILE,
	parseBotDeskFile,
} from "../../shared/bot-desk";
import type { SchedulesState } from "../../shared/schedules";
import { writeFileAtomicSync } from "../atomic-file";

/** A refusal with a message the caller (the bot, or the owner's window) may read as it is. */
export class BotDeskError extends Error {}

export type OpenDecision = Extract<BotDecision, { state: "open" }>;
export type AnsweredDecision = Extract<BotDecision, { state: "answered" }>;

/** Who made a change: the bot through its tool, or the owner from the app. */
export type BotDeskActor = "bot" | "owner";

export interface BotDeskOptions {
	/** Where the desk lives; null keeps it in memory only. */
	file: string | null;
	now?: () => Date;
	/** A short id; the desk draws again until it is unused. */
	newId?: () => string;
	/** Hears every change as an activity entry (`bot-activity.ts`). */
	activity?: (draft: BotActivityDraft) => void;
}

export interface DecisionDraft {
	question: string;
	options?: readonly string[];
	context?: string;
}

function read(file: string): BotDeskFile {
	try {
		return parseBotDeskFile(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return EMPTY_BOT_DESK_FILE;
	}
}

function dutyRows(duties: readonly BotDuty[]): BotDeskDuties["duties"] {
	return duties.map(duty => ({ id: duty.id, text: duty.text }));
}

export class BotDesk {
	readonly #file: string | null;
	readonly #now: () => Date;
	readonly #newId: () => string;
	readonly #activity: (draft: BotActivityDraft) => void;
	readonly #listeners = new Set<() => void>();
	#data: BotDeskFile;

	constructor(options: BotDeskOptions) {
		this.#file = options.file;
		this.#now = options.now ?? (() => new Date());
		this.#newId = options.newId ?? (() => randomBytes(4).toString("hex"));
		this.#activity = options.activity ?? (() => {});
		this.#data = options.file ? read(options.file) : EMPTY_BOT_DESK_FILE;
	}

	/** What the file holds now. */
	state(): BotDeskFile {
		const data = this.#data;
		return {
			...data,
			duties: [...data.duties],
			decisions: [...data.decisions],
			memories: [...data.memories],
			channels: [...data.channels],
		};
	}

	/** Called after every change that was written; returns the unsubscribe. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Adds a duty; the same text twice is one duty (`added: false`). Refused at `BOT_DUTIES_MAX`. */
	addDuty(text: string, by: BotDeskActor = "bot"): { duty: BotDuty; added: boolean } {
		const clean = text.trim();
		const same = this.#data.duties.find(duty => duty.text === clean);
		if (same) return { duty: same, added: false };
		if (this.#data.duties.length >= BOT_DUTIES_MAX)
			throw new BotDeskError(
				`The desk holds ${BOT_DUTIES_MAX} duties already. Remove one that is over with ompdesk_bot {"action":"duty_remove"} first.`,
			);
		const before = dutyRows(this.#data.duties);
		const duty = this.#valid(BotDutySchema, { id: this.#id(), text: clean, at: this.#stamp() });
		this.#commit({ ...this.#data, duties: [...this.#data.duties, duty] });
		this.#log({ kind: "desk", action: "duty_add", by, text: duty.text, undo: { op: "duties", duties: before } });
		return { duty, added: true };
	}

	/** Drops a duty; undefined when no duty has the id. */
	removeDuty(id: string, by: BotDeskActor = "bot"): BotDuty | undefined {
		const duty = this.#data.duties.find(entry => entry.id === id);
		if (!duty) return undefined;
		const before = dutyRows(this.#data.duties);
		this.#commit({ ...this.#data, duties: this.#data.duties.filter(entry => entry !== duty) });
		this.#log({ kind: "desk", action: "duty_remove", by, text: duty.text, undo: { op: "duties", duties: before } });
		return duty;
	}

	/**
	 * The owner's whole list. A row naming a duty on the desk keeps its id and time; any other row (no id, or an id
	 * this desk does not hold, such as one a stale window still shows) is a new duty with a new id.
	 */
	setDuties(input: BotDeskDuties, by: BotDeskActor = "owner"): void {
		if (input.duties.length > BOT_DUTIES_MAX)
			throw new BotDeskError(`The desk holds at most ${BOT_DUTIES_MAX} duties.`);
		const held = new Map(this.#data.duties.map(duty => [duty.id, duty]));
		const keptIds = new Set<string>();
		const rows = input.duties.map(row => {
			const kept = row.id === undefined || keptIds.has(row.id) ? undefined : held.get(row.id);
			if (kept) keptIds.add(kept.id);
			return { kept, text: row.text.trim() };
		});
		const taken = new Set([...keptIds, ...this.#ids()]);
		const duties = rows.map(({ kept, text }) => {
			if (kept) return this.#valid(BotDutySchema, { ...kept, text });
			const id = this.#id(taken);
			taken.add(id);
			return this.#valid(BotDutySchema, { id, text, at: this.#stamp() });
		});
		if (JSON.stringify(duties) === JSON.stringify(this.#data.duties)) return;
		const before = dutyRows(this.#data.duties);
		this.#commit({ ...this.#data, duties });
		this.#log({
			kind: "desk",
			action: "duties_set",
			by,
			text: duties.map(duty => duty.text).join(" · "),
			undo: { op: "duties", duties: before },
		});
	}

	/** Posts a decision for the owner and returns it open; nothing waits on it. */
	postDecision(draft: DecisionDraft): OpenDecision {
		const options = [...new Set((draft.options ?? []).map(option => option.trim()))];
		if (options.length > BOT_DECISION_OPTIONS_MAX)
			throw new BotDeskError(`A decision offers at most ${BOT_DECISION_OPTIONS_MAX} options.`);
		const context = draft.context?.trim();
		const decision = this.#valid(BotDecisionSchema, {
			id: this.#id(),
			state: "open",
			question: draft.question.trim(),
			options,
			...(context ? { context } : {}),
			at: this.#stamp(),
		});
		if (decision.state !== "open") throw new BotDeskError("A new decision is open.");
		this.#commit({ ...this.#data, decisions: [...this.#data.decisions, decision] });
		this.#log({ kind: "desk", action: "decision_post", by: "bot", text: decision.question });
		return decision;
	}

	/**
	 * The owner's answer. Refused for an id the desk does not hold and for one already answered, so an answer the bot
	 * heard once is never sent a second time. Keeps the newest `BOT_DECISIONS_ANSWERED_KEPT` answered decisions and
	 * every open one.
	 */
	answer(id: string, answer: string): AnsweredDecision {
		const index = this.#data.decisions.findIndex(decision => decision.id === id);
		const current = this.#data.decisions[index];
		if (!current) throw new BotDeskError(`No decision "${id}" is on the desk.`);
		if (current.state === "answered") throw new BotDeskError(`Decision "${id}" was already answered.`);
		const answered = this.#valid(BotDecisionSchema, {
			...current,
			state: "answered",
			answer: answer.trim(),
			answeredAt: this.#stamp(),
		});
		if (answered.state !== "answered") throw new BotDeskError("An answered decision is answered.");
		const decisions = this.#data.decisions.map((decision, at) => (at === index ? answered : decision));
		this.#commit({ ...this.#data, decisions: keepNewestAnswered(decisions) });
		this.#log({
			kind: "desk",
			action: "decision_answer",
			by: "owner",
			text: `${answered.question} → ${answered.answer}`,
		});
		return answered;
	}

	/**
	 * Saves a memory; the same text twice is one memory (`added: false`). Refused at `BOT_MEMORIES_MAX`, so the bot
	 * forgets one that no longer holds before it adds another.
	 */
	remember(text: string, by: BotDeskActor): { memory: BotMemory; added: boolean } {
		const clean = text.replace(/\s+/g, " ").trim();
		const same = this.#data.memories.find(memory => memory.text === clean);
		if (same) return { memory: same, added: false };
		if (this.#data.memories.length >= BOT_MEMORIES_MAX)
			throw new BotDeskError(
				`Memory holds ${BOT_MEMORIES_MAX} entries already. Forget one that no longer holds (ompdesk_bot {"action":"forget"}) or merge two into one first.`,
			);
		const memory = this.#valid(BotMemorySchema, { id: this.#id(), text: clean, by, at: this.#stamp() });
		this.#commit({ ...this.#data, memories: [...this.#data.memories, memory] });
		this.#log({
			kind: "desk",
			action: "memory_add",
			by,
			text: memory.text,
			undo: { op: "memory_forget", id: memory.id },
		});
		return { memory, added: true };
	}

	/** Forgets a memory; undefined when none has the id. The log keeps it, so the owner can put it back. */
	forget(id: string, by: BotDeskActor): BotMemory | undefined {
		const memory = this.#data.memories.find(entry => entry.id === id);
		if (!memory) return undefined;
		this.#commit({ ...this.#data, memories: this.#data.memories.filter(entry => entry !== memory) });
		this.#log({
			kind: "desk",
			action: "memory_forget",
			by,
			text: memory.text,
			undo: { op: "memory_restore", memory },
		});
		return memory;
	}

	/** A change the desk makes on its own (the owner's edits, and the Undo of earlier ones). */
	change(edit: BotDeskChange, by: BotDeskActor): void {
		switch (edit.op) {
			case "duties":
				return this.setDuties({ duties: edit.duties }, by);
			case "memory_add":
				this.remember(edit.text, by);
				return;
			case "memory_forget":
				if (!this.forget(edit.id, by)) throw new BotDeskError(`No memory "${edit.id}" is kept.`);
				return;
			case "memory_edit":
				return this.#editMemory(edit.id, edit.text, by);
			case "memory_restore":
				return this.#restoreMemory(edit.memory, by);
			case "memory_import":
				return this.#importMemories(edit.texts, edit.replace, by);
			case "identity": {
				const { op: _, ...fields } = edit;
				const before = this.#data.identity;
				const identity = this.#valid(BotIdentitySchema, { ...before, ...fields });
				if (JSON.stringify(identity) === JSON.stringify(before)) return;
				this.#commit({ ...this.#data, identity });
				this.#log({
					kind: "desk",
					action: "identity",
					by,
					text: Object.keys(fields).join(", "),
					undo: { op: "identity", ...before },
				});
				return;
			}
			case "notify": {
				const { op: _, ...fields } = edit;
				const before = this.#data.notify;
				const notify = this.#valid(BotNotifySchema, { ...before, ...fields });
				if (JSON.stringify(notify) === JSON.stringify(before)) return;
				this.#commit({ ...this.#data, notify });
				this.#log({
					kind: "desk",
					action: "notify_settings",
					by,
					text: Object.entries(fields)
						.map(([key, value]) => `${key}: ${String(value)}`)
						.join(", "),
					undo: { op: "notify", ...before },
				});
				return;
			}
			case "voice": {
				const before = this.#data.voice;
				const voice = this.#valid(BotVoiceSchema, { ...before, speakReplies: edit.speakReplies });
				if (voice.speakReplies === before.speakReplies) return;
				this.#commit({ ...this.#data, voice });
				this.#log({
					kind: "desk",
					action: "voice",
					by,
					text: voice.speakReplies ? "on" : "off",
					undo: { op: "voice", speakReplies: before.speakReplies },
				});
				return;
			}
		}
	}

	/** Refuses before a side chat's session is made when the desk could not keep it. */
	assertChannelRoom(): void {
		if (this.#data.channels.length >= BOT_CHANNELS_MAX)
			throw new BotDeskError(`The bot keeps at most ${BOT_CHANNELS_MAX} side chats. Delete one first.`);
	}

	/** Records a side chat main made for `sessionPath`. Refused at `BOT_CHANNELS_MAX`. */
	addChannel(title: string, sessionPath: string, by: BotDeskActor): BotChannel {
		const same = this.#data.channels.find(channel => channel.sessionPath === sessionPath);
		if (same) return same;
		this.assertChannelRoom();
		const channel = this.#valid(BotChannelSchema, { id: this.#id(), title, sessionPath, at: this.#stamp() });
		this.#commit({ ...this.#data, channels: [...this.#data.channels, channel] });
		this.#log({ kind: "desk", action: "channel_add", by, text: channel.title });
		return channel;
	}

	/** Forgets a side chat (its session is deleted by the caller first); undefined when none has the id. */
	removeChannel(id: string, by: BotDeskActor): BotChannel | undefined {
		const channel = this.#data.channels.find(entry => entry.id === id);
		if (!channel) return undefined;
		this.#commit({ ...this.#data, channels: this.#data.channels.filter(entry => entry !== channel) });
		this.#log({ kind: "desk", action: "channel_remove", by, text: channel.title });
		return channel;
	}

	/** The side chat whose session is `sessionPath`. */
	channelOf(sessionPath: string): BotChannel | undefined {
		return this.#data.channels.find(channel => channel.sessionPath === sessionPath);
	}

	#editMemory(id: string, text: string, by: BotDeskActor): void {
		const index = this.#data.memories.findIndex(memory => memory.id === id);
		const before = this.#data.memories[index];
		if (!before) throw new BotDeskError(`No memory "${id}" is kept.`);
		const clean = text.replace(/\s+/g, " ").trim();
		if (clean === before.text) return;
		if (this.#data.memories.some(memory => memory.id !== id && memory.text === clean))
			throw new BotDeskError("Another memory says the same.");
		const memory = this.#valid(BotMemorySchema, { ...before, text: clean, by, at: this.#stamp() });
		this.#commit({
			...this.#data,
			memories: this.#data.memories.map((entry, at) => (at === index ? memory : entry)),
		});
		this.#log({
			kind: "desk",
			action: "memory_edit",
			by,
			text: memory.text,
			undo: { op: "memory_edit", id, text: before.text },
		});
	}

	#restoreMemory(memory: BotMemory, by: BotDeskActor): void {
		if (this.#data.memories.some(entry => entry.id === memory.id || entry.text === memory.text)) return;
		if (this.#data.memories.length >= BOT_MEMORIES_MAX)
			throw new BotDeskError(`Memory holds ${BOT_MEMORIES_MAX} entries already. Forget one first.`);
		const restored = this.#valid(BotMemorySchema, memory);
		this.#commit({ ...this.#data, memories: [...this.#data.memories, restored] });
		this.#log({
			kind: "desk",
			action: "memory_restore",
			by,
			text: restored.text,
			undo: { op: "memory_forget", id: restored.id },
		});
	}

	/** Adds each text not kept yet (as many as fit), or replaces every memory with them. */
	#importMemories(texts: readonly string[], replace: boolean, by: BotDeskActor): void {
		const before = this.#data.memories;
		const kept = replace ? [] : [...before];
		const taken = new Set(this.#ids());
		for (const raw of texts) {
			const text = raw.replace(/\s+/g, " ").trim();
			if (!text || kept.some(memory => memory.text === text)) continue;
			if (kept.length >= BOT_MEMORIES_MAX) break;
			const id = this.#id(taken);
			taken.add(id);
			kept.push(this.#valid(BotMemorySchema, { id, text, by, at: this.#stamp() }));
		}
		if (JSON.stringify(kept) === JSON.stringify(before)) return;
		this.#commit({ ...this.#data, memories: kept });
		this.#log({
			kind: "desk",
			action: "memory_import",
			by,
			text: `${kept.length}`,
			undo: { op: "memory_import", texts: before.map(memory => memory.text), replace: true },
		});
	}

	#log(draft: BotActivityDraft): void {
		try {
			this.#activity(draft);
		} catch (error) {
			console.warn(`[bot-desk] the activity log failed: ${error}`);
		}
	}

	#stamp(): string {
		return this.#now().toISOString();
	}

	#ids(): string[] {
		const data = this.#data;
		return [...data.duties, ...data.decisions, ...data.memories, ...data.channels].map(item => item.id);
	}

	#id(taken?: ReadonlySet<string>): string {
		const used = new Set<string>(taken);
		for (const id of this.#ids()) used.add(id);
		for (;;) {
			const id = this.#newId();
			if (!used.has(id)) return id;
		}
	}

	#valid<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
		const parsed = schema.safeParse(value);
		if (parsed.success) return parsed.data;
		throw new BotDeskError(
			parsed.error.issues.map(issue => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; "),
		);
	}

	#commit(next: BotDeskFile): void {
		if (this.#file) writeFileAtomicSync(this.#file, JSON.stringify(next), { mode: 0o600 });
		this.#data = next;
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				console.warn(`[bot-desk] a listener failed: ${error}`);
			}
		}
	}
}

/** Edits whose inverse an Undo replays here; the others (side chats, undo itself) go through `ipc.ts`. */
export function isDeskChange(edit: BotDeskEdit): edit is BotDeskChange {
	return edit.op !== "channel_add" && edit.op !== "channel_remove" && edit.op !== "undo";
}

/** Every open decision, and the `BOT_DECISIONS_ANSWERED_KEPT` answered ones that were answered last. */
function keepNewestAnswered(decisions: readonly BotDecision[]): BotDecision[] {
	const answered = decisions.flatMap((decision, index) =>
		decision.state === "answered" ? [{ decision, index }] : [],
	);
	const oldest = answered
		.sort((a, b) => a.decision.answeredAt.localeCompare(b.decision.answeredAt) || a.index - b.index)
		.slice(0, Math.max(0, answered.length - BOT_DECISIONS_ANSWERED_KEPT));
	const drop = new Set(oldest.map(entry => entry.index));
	return decisions.filter((_, index) => !drop.has(index));
}

/**
 * The bot's own wake-ups among the schedules: those delivering into its session file (`wakeSession`), soonest first,
 * the paused or off ones last.
 */
export function botWakes(schedules: Pick<SchedulesState, "schedules" | "nextRuns">, botPath: string | null): BotWake[] {
	if (botPath === null) return [];
	const wakes = schedules.schedules
		.filter(schedule => schedule.wakeSession === botPath)
		.map(schedule => ({
			id: schedule.id,
			prompt: schedule.prompt,
			next: schedule.enabled ? (schedules.nextRuns[schedule.id] ?? null) : null,
		}));
	return wakes.sort((a, b) => {
		if (a.next === b.next) return 0;
		if (a.next === null) return 1;
		if (b.next === null) return -1;
		return a.next.localeCompare(b.next);
	});
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What `ompdesk_bot {"action":"desk"}` returns. */
export function botDeskText(desk: BotDeskState): string {
	const open = desk.decisions.filter(decision => decision.state === "open");
	return [
		desk.duties.length > 0
			? `Standing duties (${desk.duties.length}):\n${botDutiesText(desk.duties)}`
			: "Standing duties: none.",
		open.length > 0
			? `Open decisions (${open.length}), waiting for the owner:\n${open
					.map(
						decision =>
							`- ${decision.id}: ${oneLine(decision.question, 200)}${decision.options.length > 0 ? ` [options: ${decision.options.join(" | ")}]` : ""} (posted ${decision.at})`,
					)
					.join("\n")}`
			: "Open decisions: none.",
		desk.wakes.length > 0
			? `Wakes you scheduled (${desk.wakes.length}):\n${desk.wakes
					.map(
						wake =>
							`- ${wake.id}: ${wake.next ? `next ${wake.next}` : "not scheduled"}: ${oneLine(wake.prompt, 120)}`,
					)
					.join("\n")}`
			: "Wakes you scheduled: none.",
	].join("\n");
}
