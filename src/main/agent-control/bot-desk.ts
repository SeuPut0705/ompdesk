/**
 * The bot's desk (`shared/bot-desk.ts`): its standing duties and the decisions it posted for the owner, in
 * `<userData>/bot-desk.json`. Main alone writes it: the bot through `ompdesk_bot`, the owner through the IPC handlers
 * in `ipc.ts`. Every change is written (atomically) before it is kept and heard, so what a window reads is what a
 * relaunch finds. A file that cannot be read is an empty desk.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ZodType, ZodTypeDef } from "zod";
import {
	BOT_DECISION_OPTIONS_MAX,
	BOT_DECISIONS_ANSWERED_KEPT,
	BOT_DUTIES_MAX,
	type BotDecision,
	BotDecisionSchema,
	type BotDeskDuties,
	type BotDeskFile,
	type BotDeskState,
	type BotDuty,
	BotDutySchema,
	type BotWake,
	botDutiesText,
	parseBotDeskFile,
} from "../../shared/bot-desk";
import type { SchedulesState } from "../../shared/schedules";
import { writeFileAtomicSync } from "../atomic-file";

/** A refusal with a message the caller (the bot, or the owner's window) may read as it is. */
export class BotDeskError extends Error {}

export type OpenDecision = Extract<BotDecision, { state: "open" }>;
export type AnsweredDecision = Extract<BotDecision, { state: "answered" }>;

export interface BotDeskOptions {
	/** Where the desk lives; null keeps it in memory only. */
	file: string | null;
	now?: () => Date;
	/** A short id; the desk draws again until it is unused. */
	newId?: () => string;
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
		return { duties: [], decisions: [] };
	}
}

export class BotDesk {
	readonly #file: string | null;
	readonly #now: () => Date;
	readonly #newId: () => string;
	readonly #listeners = new Set<() => void>();
	#data: BotDeskFile;

	constructor(options: BotDeskOptions) {
		this.#file = options.file;
		this.#now = options.now ?? (() => new Date());
		this.#newId = options.newId ?? (() => randomBytes(4).toString("hex"));
		this.#data = options.file ? read(options.file) : { duties: [], decisions: [] };
	}

	/** What the file holds now. */
	state(): BotDeskFile {
		return { duties: [...this.#data.duties], decisions: [...this.#data.decisions] };
	}

	/** Called after every change that was written; returns the unsubscribe. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Adds a duty; the same text twice is one duty (`added: false`). Refused at `BOT_DUTIES_MAX`. */
	addDuty(text: string): { duty: BotDuty; added: boolean } {
		const clean = text.trim();
		const same = this.#data.duties.find(duty => duty.text === clean);
		if (same) return { duty: same, added: false };
		if (this.#data.duties.length >= BOT_DUTIES_MAX)
			throw new BotDeskError(
				`The desk holds ${BOT_DUTIES_MAX} duties already. Remove one that is over with ompdesk_bot {"action":"duty_remove"} first.`,
			);
		const duty = this.#valid(BotDutySchema, { id: this.#id(), text: clean, at: this.#stamp() });
		this.#commit({ ...this.#data, duties: [...this.#data.duties, duty] });
		return { duty, added: true };
	}

	/** Drops a duty; undefined when no duty has the id. */
	removeDuty(id: string): BotDuty | undefined {
		const duty = this.#data.duties.find(entry => entry.id === id);
		if (!duty) return undefined;
		this.#commit({ ...this.#data, duties: this.#data.duties.filter(entry => entry !== duty) });
		return duty;
	}

	/**
	 * The owner's whole list. A row naming a duty on the desk keeps its id and time; any other row (no id, or an id
	 * this desk does not hold, such as one a stale window still shows) is a new duty with a new id.
	 */
	setDuties(input: BotDeskDuties): void {
		if (input.duties.length > BOT_DUTIES_MAX)
			throw new BotDeskError(`The desk holds at most ${BOT_DUTIES_MAX} duties.`);
		const held = new Map(this.#data.duties.map(duty => [duty.id, duty]));
		const keptIds = new Set<string>();
		const rows = input.duties.map(row => {
			const kept = row.id === undefined || keptIds.has(row.id) ? undefined : held.get(row.id);
			if (kept) keptIds.add(kept.id);
			return { kept, text: row.text.trim() };
		});
		const taken = new Set([...keptIds, ...this.#data.decisions.map(decision => decision.id)]);
		const duties = rows.map(({ kept, text }) => {
			if (kept) return this.#valid(BotDutySchema, { ...kept, text });
			const id = this.#id(taken);
			taken.add(id);
			return this.#valid(BotDutySchema, { id, text, at: this.#stamp() });
		});
		if (JSON.stringify(duties) === JSON.stringify(this.#data.duties)) return;
		this.#commit({ ...this.#data, duties });
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
			id: current.id,
			state: "answered",
			question: current.question,
			options: current.options,
			...(current.context === undefined ? {} : { context: current.context }),
			at: current.at,
			answer: answer.trim(),
			answeredAt: this.#stamp(),
		});
		if (answered.state !== "answered") throw new BotDeskError("An answered decision is answered.");
		const decisions = this.#data.decisions.map((decision, at) => (at === index ? answered : decision));
		this.#commit({ ...this.#data, decisions: keepNewestAnswered(decisions) });
		return answered;
	}

	#stamp(): string {
		return this.#now().toISOString();
	}

	#id(taken?: ReadonlySet<string>): string {
		const used = new Set<string>(taken);
		for (const item of [...this.#data.duties, ...this.#data.decisions]) used.add(item.id);
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
