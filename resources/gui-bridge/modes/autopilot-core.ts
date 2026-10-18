/**
 * Autopilot's pure rules: rotation, duplicate prevention, the cycle classification (red / no commit /
 * no report / churn / stall), release due-ness, quote verification, the status built from the journal.
 * No omp imports (not even types): the GUI's vitest loads this file directly
 * (src/main/bridge-autopilot-core.test.ts); ./autopilot.ts wires it to the session.
 */
import {
	AUTOPILOT_AREAS,
	AUTOPILOT_BACKLOG_ENTRY,
	AUTOPILOT_CYCLE_ENTRY,
	AUTOPILOT_GUIDE_MAX_BYTES,
	AUTOPILOT_NOTE_ENTRY,
	AUTOPILOT_SHIP_REQUEST_ENTRY,
	AUTOPILOT_STATE_ENTRY,
	type AutopilotArea,
	type AutopilotBacklogEvent,
	type AutopilotBacklogItem,
	type AutopilotBeginResult,
	type AutopilotChangeStat,
	type AutopilotCycleArea,
	type AutopilotCycleRecord,
	type AutopilotLimits,
	type AutopilotNote,
	type AutopilotNudgeReason,
	type AutopilotPauseReason,
	type AutopilotSettings,
	type AutopilotShipLevel,
	type AutopilotShipPolicy,
	type AutopilotShipRequest,
	type AutopilotStateEntry,
	type AutopilotStatus,
	type AutopilotStopRequest,
	type AutopilotToolInput,
	type AutopilotVerifyNote,
	DEFAULT_AUTOPILOT_SETTINGS,
	DUPLICATE_WINDOW,
	isAutopilotArea,
	MAX_PARALLEL_CHILDREN,
	RECENT_CYCLES,
} from "./autopilot-contracts";

/** One session journal entry as these rules read it (the slice of omp's SessionEntry they need). */
export interface JournalEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: unknown;
}

// ---------------------------------------------------------------------------------------------
// Titles, rotation, duplicates
// ---------------------------------------------------------------------------------------------

/** A title as the duplicate check compares it: case, punctuation and spacing ignored (Hangul kept). */
export function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** The last {@link DUPLICATE_WINDOW} cycles: a repeat of one of their titles is not picked again. */
export function isDuplicateTitle(records: readonly AutopilotCycleRecord[], title: string): boolean {
	const wanted = normalizeTitle(title);
	if (!wanted) return false;
	return records
		.slice(-DUPLICATE_WINDOW)
		.some(record => record.area !== "unreported" && normalizeTitle(record.title) === wanted);
}

export interface Rotation {
	suggested: AutopilotArea;
	counts: Record<AutopilotArea, number>;
	lastCycleOfArea: Record<AutopilotArea, number | null>;
}

/** Counts, last cycle and the area that has waited longest (never-done first; ties in {@link AUTOPILOT_AREAS} order), within `focus` (empty = all). */
export function rotation(records: readonly AutopilotCycleRecord[], focus: readonly AutopilotArea[]): Rotation {
	const counts = Object.fromEntries(AUTOPILOT_AREAS.map(area => [area, 0])) as Record<AutopilotArea, number>;
	const lastCycleOfArea = Object.fromEntries(AUTOPILOT_AREAS.map(area => [area, null])) as Record<
		AutopilotArea,
		number | null
	>;
	for (const record of records) {
		if (!isAutopilotArea(record.area)) continue;
		counts[record.area]++;
		lastCycleOfArea[record.area] = Math.max(lastCycleOfArea[record.area] ?? 0, record.n);
	}
	const candidates = focus.length > 0 ? AUTOPILOT_AREAS.filter(area => focus.includes(area)) : [...AUTOPILOT_AREAS];
	let suggested = candidates[0] ?? AUTOPILOT_AREAS[0];
	for (const area of candidates) {
		const best = lastCycleOfArea[suggested];
		const here = lastCycleOfArea[area];
		if (best !== null && (here === null || here < best)) suggested = area;
	}
	return { suggested, counts, lastCycleOfArea };
}

// ---------------------------------------------------------------------------------------------
// Cycle classification
// ---------------------------------------------------------------------------------------------

/** Red: reported red, or committed without a green verification. Skipped/unreported without a commit is neutral. */
export function isRedCycle(record: Pick<AutopilotCycleRecord, "verify" | "commit">): boolean {
	if (record.verify === "red") return true;
	return Boolean(record.commit) && record.verify !== "green";
}

function isNeutralCycle(record: Pick<AutopilotCycleRecord, "verify" | "commit">): boolean {
	return !record.commit && (record.verify === "skipped" || record.verify === "unreported");
}

/** Consecutive red cycles at the end; a green cycle ends the run of them, a neutral one (skipped, no commit) neither counts nor ends it. */
export function redStreak(records: readonly AutopilotCycleRecord[]): number {
	let streak = 0;
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (isRedCycle(record)) streak++;
		else if (!isNeutralCycle(record)) break;
	}
	return streak;
}

export interface StallFacts {
	/** The last assistant message ended in an error. */
	lastTurnErrored: boolean;
	/** Plan mode is on (stock quietly stops continuing). */
	planMode: boolean;
	/** The todo list is non-empty and every item is blocked. */
	todosAllBlocked: boolean;
}

/** Why no new turn started after a terminal agent_end: plan mode, a failed turn (the quota/retry path is main's) or a quiet one. */
export type StallVerdict = { kind: "error" } | { kind: "nudge"; reason: AutopilotNudgeReason };

/** A quiet run is nudged to its next cycle, never paused. */
export function classifyStall(facts: StallFacts): StallVerdict {
	if (facts.planMode) return { kind: "nudge", reason: "plan" };
	if (facts.lastTurnErrored) return { kind: "error" };
	return { kind: "nudge", reason: facts.todosAllBlocked ? "blocked" : "no_progress" };
}

export interface UsageTotals {
	tokens: number;
	usd: number;
}

/** Which optional ceiling is used up, if any (`tokens` -> budget, `minutes` -> time, `cycles` -> cycles, `usd` -> cost). */
export function limitReached(
	limits: AutopilotLimits,
	used: UsageTotals,
	activeMs: number,
	cyclesDone: number,
): AutopilotPauseReason | undefined {
	if (limits.tokens !== null && used.tokens >= limits.tokens) return "budget";
	if (limits.minutes !== null && activeMs >= limits.minutes * 60_000) return "time";
	if (limits.cycles !== null && cyclesDone >= limits.cycles) return "cycles";
	if (limits.usd !== null && used.usd >= limits.usd) return "cost";
	return undefined;
}

/** The ceilings still open, for `begin.budgetLeft` (only the ones that are on). */
export function budgetLeft(
	limits: AutopilotLimits,
	used: UsageTotals,
	activeMs: number,
	cyclesDone: number,
): Partial<AutopilotLimits> | undefined {
	const left: Partial<AutopilotLimits> = {};
	if (limits.tokens !== null) left.tokens = Math.max(0, limits.tokens - used.tokens);
	if (limits.minutes !== null) left.minutes = Math.max(0, Math.ceil(limits.minutes - activeMs / 60_000));
	if (limits.cycles !== null) left.cycles = Math.max(0, limits.cycles - cyclesDone);
	if (limits.usd !== null) left.usd = Math.max(0, limits.usd - used.usd);
	return Object.keys(left).length > 0 ? left : undefined;
}

export interface CycleEndFacts {
	/** Every record including the one that just ended. */
	records: readonly AutopilotCycleRecord[];
	settings: AutopilotSettings;
	used: UsageTotals;
	activeMs: number;
}

/**
 * What a finished cycle means for the run: a pause request when a ceiling the user set is used up, else nothing. A red
 * cycle, a failed check, a missing report, compaction churn or a cycle without a commit never stop the run: the next
 * cycle repairs them (`redStreak` rides `begin` and the status as the counter).
 */
export function decideAfterCycle(facts: CycleEndFacts): AutopilotStopRequest | undefined {
	const limit = limitReached(facts.settings.limits, facts.used, facts.activeMs, facts.records.length);
	return limit ? { reason: limit } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------------------------

function isReleaseCycle(record: AutopilotCycleRecord): boolean {
	return record.area === "release" || record.ship?.kind === "release";
}

/** Green, committed cycles since the last release cycle (a release cycle that went red does not reset it). */
export function greenCyclesSinceRelease(records: readonly AutopilotCycleRecord[]): number {
	let count = 0;
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (isReleaseCycle(record) && record.verify === "green") break;
		if (!isReleaseCycle(record) && record.verify === "green" && record.commit && !record.reverted) count++;
	}
	return count;
}

export interface ReleaseFacts {
	policy: AutopilotShipPolicy;
	records: readonly AutopilotCycleRecord[];
	/** The repo defines a release procedure (main detected it). */
	hasProcedure: boolean;
	/**
	 * A release is already under way. A push in flight does not count: main's automatic push of the last green cycle
	 * routinely outlives the next `begin`, and a push slower than that gap would otherwise hold every release back.
	 */
	releaseInFlight: boolean;
	/** The agent called `propose_release` and the bridge accepted it this cycle. */
	proposed: boolean;
}

/** Whether `begin.ship.due` is true: auto release on, a procedure exists, no release in flight, the last cycle green with no red streak, and the cadence reached. */
export function dueForRelease(facts: ReleaseFacts): boolean {
	const { policy, records } = facts;
	if (!policy.autoRelease.on || !facts.hasProcedure || facts.releaseInFlight) return false;
	const last = records[records.length - 1];
	if (last?.verify !== "green" || redStreak(records) > 0) return false;
	const green = greenCyclesSinceRelease(records);
	if (policy.autoRelease.cadence.kind === "agent") return facts.proposed && green >= 1;
	return green >= Math.max(1, policy.autoRelease.cadence.n);
}

/** `propose_release`: the preconditions the bridge verifies (the clean working tree is a fact the caller passes). */
export function proposeReleaseCheck(
	records: readonly AutopilotCycleRecord[],
	facts: { policyOn: boolean; hasProcedure: boolean; releaseInFlight: boolean; clean: boolean },
): { ok: true } | { ok: false; reason: string } {
	if (!facts.policyOn) return { ok: false, reason: "auto release is off" };
	if (!facts.hasProcedure) return { ok: false, reason: "the repository defines no release procedure" };
	if (facts.releaseInFlight) return { ok: false, reason: "a release is already in flight" };
	const last = records[records.length - 1];
	if (last?.verify !== "green") return { ok: false, reason: "the last cycle was not green" };
	if (redStreak(records) > 0) return { ok: false, reason: "there is a red streak" };
	if (greenCyclesSinceRelease(records) < 1) return { ok: false, reason: "no green cycle since the last release" };
	if (!facts.clean) return { ok: false, reason: "the working tree is not clean" };
	return { ok: true };
}

/** The level the guard enforces: the release scope opens only when auto release is on and due. */
export function shipLevelOf(policy: AutopilotShipPolicy, due: boolean): AutopilotShipLevel {
	if (policy.autoRelease.on && due) return "release";
	return policy.autoPush ? "push" : "local";
}

type InFlightMark = NonNullable<AutopilotStateEntry["inFlight"]>;

/**
 * The in-flight mark after main's `setState` asks for `change` (`null` clears, `undefined` leaves it). Main marks
 * only its own pushes and clears them once they settle; a release mark is the bridge's (a due `begin`, `ship release`,
 * `propose_release`, cleared when that cycle ends), so a push that overlaps the release cycle neither replaces nor
 * clears it.
 */
export function inFlightAfter(
	prev: InFlightMark | undefined,
	change: InFlightMark | null | undefined,
): InFlightMark | undefined {
	if (change === undefined || (prev?.kind === "release" && change?.kind !== "release")) return prev;
	return change ?? undefined;
}

// ---------------------------------------------------------------------------------------------
// "Push now" / "release now" quotes
// ---------------------------------------------------------------------------------------------

const AGENT_WRAP = /^\s*<ompdesk-agent-message[\s>]/;
const INTENT: Record<"push" | "release", RegExp> = {
	push: /push|푸시|올려|업로드|upload|send it|ship/i,
	release: /release|ship|deploy|publish|배포|릴리스|릴리즈|출시/i,
};
export const MIN_QUOTE_LENGTH = 3;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
				? String((block as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

/** A message the user typed: role user, not synthetic, not attributed to an agent, not another session's wrapped message. */
export function realUserText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const m = message as { role?: unknown; synthetic?: unknown; attribution?: unknown; content?: unknown };
	if (m.role !== "user" || m.synthetic === true) return undefined;
	if (m.attribution !== undefined && m.attribution !== "user") return undefined;
	const text = textOf(m.content);
	return text.trim() === "" || AGENT_WRAP.test(text) ? undefined : text;
}

/** The user's real messages since the last finished cycle (what a quote may come from). */
export function userMessagesSinceLastCycle(entries: readonly JournalEntry[]): string[] {
	let messages: string[] = [];
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === AUTOPILOT_CYCLE_ENTRY) messages = [];
		else if (entry.type === "message") {
			const text = realUserText(entry.message);
			if (text !== undefined) messages.push(text);
		}
	}
	return messages;
}

function squash(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The quote must be the user's own words (a substring of a real user message) and say what it asks for. */
export function verifyShipQuote(
	kind: "push" | "release",
	quote: string,
	userMessages: readonly string[],
): { ok: true } | { ok: false; reason: string } {
	const wanted = squash(quote);
	if (wanted.length < MIN_QUOTE_LENGTH) return { ok: false, reason: "the quote is empty or too short" };
	if (!userMessages.some(message => squash(message).includes(wanted))) {
		return { ok: false, reason: "the quote is not in a message the user sent this turn" };
	}
	if (!INTENT[kind].test(wanted)) return { ok: false, reason: `the quote does not ask for a ${kind}` };
	return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Settings and journal entries
// ---------------------------------------------------------------------------------------------

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.round(value)))
		: fallback;
}

function limitValue(value: unknown, previous: number | null): number | null {
	if (value === null) return null;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : previous;
}

/** `base` with the valid parts of `patch` applied; invalid values keep the old ones. */
export function mergeSettings(
	base: AutopilotSettings,
	patch: Partial<Record<keyof AutopilotSettings, unknown>> & {
		ship?: Partial<AutopilotShipPolicy>;
		limits?: Partial<AutopilotLimits>;
	},
): AutopilotSettings {
	const focus = Array.isArray(patch.focus)
		? [...new Set((patch.focus as unknown[]).filter(isAutopilotArea))]
		: base.focus;
	const ship = patch.ship ?? {};
	const autoRelease = ship.autoRelease;
	const cadence = autoRelease?.cadence;
	const limits = patch.limits ?? {};
	return {
		focus,
		ship: {
			autoPush: typeof ship.autoPush === "boolean" ? ship.autoPush : base.ship.autoPush,
			autoRelease: {
				on: typeof autoRelease?.on === "boolean" ? autoRelease.on : base.ship.autoRelease.on,
				cadence:
					cadence?.kind === "agent"
						? { kind: "agent" }
						: cadence?.kind === "every"
							? { kind: "every", n: clampInt(cadence.n, 1, 1000, 5) }
							: base.ship.autoRelease.cadence,
			},
			remote: typeof ship.remote === "string" && ship.remote.trim() ? ship.remote.trim() : base.ship.remote,
		},
		limits: {
			tokens: "tokens" in limits ? limitValue(limits.tokens, base.limits.tokens) : base.limits.tokens,
			minutes: "minutes" in limits ? limitValue(limits.minutes, base.limits.minutes) : base.limits.minutes,
			cycles: "cycles" in limits ? limitValue(limits.cycles, base.limits.cycles) : base.limits.cycles,
			usd: "usd" in limits ? limitValue(limits.usd, base.limits.usd) : base.limits.usd,
		},
		maxParallel: clampInt(patch.maxParallel, 0, MAX_PARALLEL_CHILDREN, base.maxParallel),
		notify:
			patch.notify === "stops" || patch.notify === "cycles" || patch.notify === "off" ? patch.notify : base.notify,
	};
}

/** The next state entry: `patch` over `prev`, with the active time of a running stretch added up. */
export function nextStateEntry(
	prev: AutopilotStateEntry,
	patch: Partial<Omit<AutopilotStateEntry, "at" | "activeMs">>,
	now: number,
): AutopilotStateEntry {
	const ran = prev.state === "running" || prev.state === "stopping" ? Math.max(0, now - prev.at) : 0;
	const next: AutopilotStateEntry = { ...prev, ...patch, activeMs: prev.activeMs + ran, at: now };
	// A state change drops what only made sense in the previous state.
	if (patch.state !== undefined && patch.state !== prev.state) {
		if (!("reason" in patch)) delete next.reason;
		if (!("detail" in patch)) delete next.detail;
		if (!("quotaResetAt" in patch)) delete next.quotaResetAt;
	}
	return next;
}

/** Verified requests not yet taken: a request entry with no later entry marking its `at` as consumed. */
export function pendingShipRequests(entries: readonly JournalEntry[]): AutopilotShipRequest[] {
	const all = customEntries<AutopilotShipRequest>(entries, AUTOPILOT_SHIP_REQUEST_ENTRY);
	const taken = new Set(all.filter(entry => entry.consumedAt !== undefined).map(entry => entry.at));
	return all.filter(entry => entry.consumedAt === undefined && !taken.has(entry.at));
}

/** The custom entries of one type, oldest first. */
export function customEntries<T>(entries: readonly JournalEntry[], customType: string): T[] {
	const out: T[] = [];
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === customType &&
			typeof entry.data === "object" &&
			entry.data !== null
		) {
			out.push(entry.data as T);
		}
	}
	return out;
}

/** The last state entry: the run's current state. */
export function lastStateEntry(entries: readonly JournalEntry[]): AutopilotStateEntry | undefined {
	return customEntries<AutopilotStateEntry>(entries, AUTOPILOT_STATE_ENTRY).at(-1);
}

/** Every cycle record, one per cycle number: a later entry with the same `n` (an amendment, a revert mark) replaces the earlier one. */
export function cycleRecords(entries: readonly JournalEntry[]): AutopilotCycleRecord[] {
	const byNumber = new Map<number, AutopilotCycleRecord>();
	for (const record of customEntries<AutopilotCycleRecord>(entries, AUTOPILOT_CYCLE_ENTRY)) {
		if (typeof record.n === "number") byNumber.set(record.n, record);
	}
	return [...byNumber.values()].sort((a, b) => a.n - b.n);
}

/** The pinned backlog: add/remove/done events replayed; removed items are gone, done ones stay marked. */
export function backlogItems(entries: readonly JournalEntry[]): AutopilotBacklogItem[] {
	const items = new Map<string, AutopilotBacklogItem>();
	for (const event of customEntries<AutopilotBacklogEvent>(entries, AUTOPILOT_BACKLOG_ENTRY)) {
		if (event.op === "add" && event.text) items.set(event.id, { id: event.id, text: event.text, done: false });
		else if (event.op === "remove") items.delete(event.id);
		else if (event.op === "done") {
			const item = items.get(event.id);
			if (item) items.set(event.id, { ...item, done: true, cycle: event.cycle });
		}
	}
	return [...items.values()];
}

/** Notes the next `begin` has not delivered yet: added after the last cycle's (or the cycle in flight's) begin. */
export function pendingNotes(
	entries: readonly JournalEntry[],
	records: readonly AutopilotCycleRecord[],
	liveBeginAt: number | undefined,
): AutopilotNote[] {
	const beganAt = Math.max(liveBeginAt ?? 0, records.at(-1)?.startedAt ?? 0);
	return customEntries<AutopilotNote>(entries, AUTOPILOT_NOTE_ENTRY).filter(note => note.at > beganAt);
}

/** Follow-ups of the recent cycles that no later cycle's title mentions, newest first, without repeats. */
export function openFollowups(records: readonly AutopilotCycleRecord[]): string[] {
	const window = records.slice(-DUPLICATE_WINDOW);
	const open: string[] = [];
	const seen = new Set<string>();
	for (let i = window.length - 1; i >= 0; i--) {
		for (const followup of window[i].followups ?? []) {
			const key = normalizeTitle(followup);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			if (window.slice(i + 1).some(later => normalizeTitle(later.title) === key)) continue;
			open.push(followup);
		}
	}
	return open;
}

// ---------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------

/** A cycle's own usage: the session counters at its end minus at its start (never negative: a compacted or reset counter reads as 0). */
export function usageDelta(start: UsageTotals, end: UsageTotals): UsageTotals {
	return { tokens: Math.max(0, end.tokens - start.tokens), usd: Math.max(0, end.usd - start.usd) };
}

export function totalsOf(records: readonly AutopilotCycleRecord[]): UsageTotals {
	return records.reduce((sum, record) => ({ tokens: sum.tokens + record.tokens, usd: sum.usd + record.usd }), {
		tokens: 0,
		usd: 0,
	});
}

/** Hourly rates from the last five cycles; absent until there are two (or when no time passed). */
export function hourlyRates(records: readonly AutopilotCycleRecord[]): { tokensPerHour?: number; usdPerHour?: number } {
	const window = records.slice(-5);
	if (window.length < 2) return {};
	const ms = window.reduce((sum, record) => sum + record.durationMs, 0);
	if (ms <= 0) return {};
	const used = totalsOf(window);
	return { tokensPerHour: Math.round((used.tokens / ms) * 3_600_000), usdPerHour: (used.usd / ms) * 3_600_000 };
}

// ---------------------------------------------------------------------------------------------
// Cycle records and results
// ---------------------------------------------------------------------------------------------

export type EndReport = Extract<AutopilotToolInput, { op: "end" }>;

export interface FinalizeFacts {
	n: number;
	/** The cycle's `autopilot end` report, if the agent made one. */
	report?: EndReport;
	/** The cycle's start as recorded: when `begin` ran, else the turn's start. */
	startedAt: number;
	/** When the turn began (the duration is measured from it); defaults to `startedAt`. */
	turnStartedAt?: number;
	now: number;
	usage: UsageTotals;
	compactions: number;
	/** What the bridge measured of the report: why the verify differs from the claim, what the cycle changed. */
	verifyNote?: AutopilotVerifyNote;
	change?: AutopilotChangeStat;
}

/** The record journaled at the terminal agent_end: the report, or `unreported`. */
export function finalizeCycle(facts: FinalizeFacts): AutopilotCycleRecord {
	const { report } = facts;
	const base = {
		n: facts.n,
		startedAt: facts.startedAt,
		durationMs: Math.max(0, facts.now - (facts.turnStartedAt ?? facts.startedAt)),
		tokens: facts.usage.tokens,
		usd: facts.usage.usd,
		compactions: facts.compactions,
	};
	if (!report) {
		return {
			...base,
			area: "unreported",
			title: "(no report)",
			summary: "The turn ended without an autopilot end report.",
			verify: "unreported",
			followups: [],
			children: [],
		};
	}
	return {
		...base,
		area: report.area,
		title: report.title.trim() || "(untitled)",
		summary: report.summary.trim(),
		verify: report.verify,
		...(report.commit ? { commit: report.commit } : {}),
		...(report.backlogId ? { backlogId: report.backlogId } : {}),
		followups: (report.followups ?? []).map(text => text.trim()).filter(Boolean),
		...(report.ship ? { ship: report.ship } : {}),
		children: report.children ?? [],
		...(facts.verifyNote ? { verifyNote: facts.verifyNote } : {}),
		...(facts.change ? { change: facts.change } : {}),
	};
}

/** Structural check of an `end` call (the tool schema is advisory; the model can send anything). */
export function parseEndReport(input: Record<string, unknown>): EndReport | { error: string } {
	const area = input.area;
	if (typeof area !== "string" || !(isAutopilotArea(area) || area === "user" || area === "release")) {
		return { error: `area must be one of ${[...AUTOPILOT_AREAS, "user", "release"].join(", ")}` };
	}
	if (typeof input.title !== "string" || !input.title.trim()) return { error: "title is required" };
	if (typeof input.summary !== "string") return { error: "summary is required" };
	if (input.verify !== "green" && input.verify !== "red" && input.verify !== "skipped") {
		return { error: "verify must be green, red or skipped" };
	}
	const report: EndReport = {
		op: "end",
		area: area as AutopilotCycleArea,
		title: input.title,
		summary: input.summary,
		verify: input.verify,
	};
	if (typeof input.commit === "string" && input.commit.trim()) report.commit = input.commit.trim();
	if (typeof input.check === "string" && input.check.trim()) report.check = input.check.trim();
	if (typeof input.backlogId === "string" && input.backlogId) report.backlogId = input.backlogId;
	if (Array.isArray(input.followups))
		report.followups = input.followups.filter((x): x is string => typeof x === "string");
	const ship = input.ship;
	if (typeof ship === "object" && ship !== null && (ship as { kind?: unknown }).kind === "release") {
		const { version, runUrl } = ship as { version?: unknown; runUrl?: unknown };
		if (typeof version === "string" && version) {
			report.ship = { kind: "release", version, ...(typeof runUrl === "string" && runUrl ? { runUrl } : {}) };
		}
	}
	if (Array.isArray(input.children)) {
		report.children = input.children.flatMap(child => {
			if (typeof child !== "object" || child === null) return [];
			const c = child as Record<string, unknown>;
			if (typeof c.session !== "string" || typeof c.branch !== "string") return [];
			const outcome = ["merged", "unmerged", "failed", "abandoned"].includes(String(c.outcome))
				? (c.outcome as "merged")
				: "unmerged";
			return [
				{ session: c.session, branch: c.branch, outcome, ...(typeof c.sha === "string" ? { sha: c.sha } : {}) },
			];
		});
	}
	return report;
}

const GUIDE_CUT_MARKER = "\n[... guide cut here: only the first 8 KB are passed on]";

/**
 * The guide as `begin` hands it on: at most `AUTOPILOT_GUIDE_MAX_BYTES` UTF-8 bytes in all (the marker included), cut on a
 * character boundary. Blank or whitespace-only text is no guide (`null`).
 */
export function boundGuide(raw: string): { text: string; truncated?: boolean } | null {
	const text = raw.replace(/^\uFEFF/, "").trim();
	if (!text) return null;
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text);
	if (bytes.length <= AUTOPILOT_GUIDE_MAX_BYTES) return { text };
	const room = AUTOPILOT_GUIDE_MAX_BYTES - encoder.encode(GUIDE_CUT_MARKER).length;
	// A cut inside a multi-byte character decodes to U+FFFD at the end: drop it.
	const cut = new TextDecoder().decode(bytes.subarray(0, room)).replace(/\uFFFD+$/, "");
	return { text: cut.trimEnd() + GUIDE_CUT_MARKER, truncated: true };
}

export interface BeginFacts {
	cycle: number;
	settings: AutopilotSettings;
	records: readonly AutopilotCycleRecord[];
	backlog: readonly AutopilotBacklogItem[];
	notes: readonly AutopilotNote[];
	stopping: boolean;
	branch: string;
	state: AutopilotStateEntry;
	due: boolean;
	used: UsageTotals;
	activeMs: number;
	/** The project guide as read at this `begin` (already bounded), or null. */
	guide?: { text: string; truncated?: boolean } | null;
}

/** Cycles a follow-up may be carried before `begin` asks for a decision on it. */
export const CARRIED_FOLLOWUP_CYCLES = 3;

/** What `begin` tells the agent to do after its audit (the static protocol only says "PICK"). */
export const BEGIN_PICK =
	'After the audit and before any edit: autopilot({op:"pick", area, title}). It shows the item in the panel and refuses a title that repeats a recent cycle. In `end`, give the commit hash and `check`, the exact command you ran as the repo\'s check.';

/** Consecutive cycles, ending with the last one, whose follow-ups name `text` (case, punctuation and spacing ignored). */
export function followupAge(records: readonly AutopilotCycleRecord[], text: string): number {
	const key = normalizeTitle(text);
	let age = 0;
	for (let i = records.length - 1; i >= 0; i--) {
		if (!(records[i].followups ?? []).some(followup => normalizeTitle(followup) === key)) break;
		age++;
	}
	return age;
}

/** What the run's own history says about this pick: follow-ups carried too long, a docs-only last cycle, fan-out cost. */
export function beginHints(
	records: readonly AutopilotCycleRecord[],
	facts: { open: readonly string[]; backlog: number; maxParallel: number },
): string[] {
	const hints: string[] = [];
	const carried = facts.open
		.map(text => ({ text, age: followupAge(records, text) }))
		.filter(item => item.age >= CARRIED_FOLLOWUP_CYCLES)
		.sort((a, b) => b.age - a.age)
		.slice(0, 2);
	for (const { text, age } of carried) {
		hints.push(
			`The follow-up "${text}" has been carried for ${age} cycles: do it now if the guide ranks it in scope, or drop it and say why in followups, before another small finding.`,
		);
	}
	const last = records.at(-1);
	if (
		last &&
		last.area !== "unreported" &&
		(last.change?.docOnly === true || (last.area === "docs" && !last.change))
	) {
		hints.push("The last cycle changed documentation only: pick code, tests or a bug unless nothing else is left.");
	}
	if (facts.maxParallel > 0 && facts.backlog + facts.open.length >= 2) {
		hints.push(
			"Fan-out pays only when each item takes several minutes: a child costs about 20 s of set-up and its own copy of the context. Small items are faster and cheaper one after the other.",
		);
	}
	return hints;
}

/** The `begin` result: everything the agent needs for the cycle, from the journal. */
export function buildBegin(facts: BeginFacts): AutopilotBeginResult {
	const { settings, records, state } = facts;
	const recent = records.slice(-RECENT_CYCLES).map(record => ({
		n: record.n,
		area: record.area,
		title: record.title,
		verify: record.verify,
		commit: record.commit,
		...(record.reverted ? { reverted: true } : {}),
	}));
	const left = budgetLeft(settings.limits, facts.used, facts.activeMs, records.length);
	const open = openFollowups(records);
	const backlog = facts.backlog.filter(item => !item.done);
	const hints = beginHints(records, { open, backlog: backlog.length, maxParallel: settings.maxParallel });
	return {
		cycle: facts.cycle,
		focus: settings.focus,
		backlog,
		notes: [...facts.notes],
		rotation: rotation(records, settings.focus),
		recent,
		openFollowups: open,
		redStreak: redStreak(records),
		stopping: facts.stopping,
		ship: {
			autoPush: settings.ship.autoPush,
			autoRelease: settings.ship.autoRelease,
			remote: settings.ship.remote,
			branch: facts.branch,
			due: facts.due,
			...(state.inFlight ? { inFlight: state.inFlight } : {}),
			...(state.releaseProcedure ? { releaseProcedure: state.releaseProcedure } : {}),
		},
		...(left ? { budgetLeft: left } : {}),
		...(facts.guide ? { guide: facts.guide } : {}),
		pick: BEGIN_PICK,
		...(hints.length > 0 ? { hints } : {}),
	};
}

// ---------------------------------------------------------------------------------------------
// Status (`get_autopilot`, `autopilot_update`)
// ---------------------------------------------------------------------------------------------

export interface LiveCycle {
	n: number;
	area?: AutopilotCycleArea;
	/** The item the agent picked (`pick`), once it has. */
	title?: string;
	startedAt: number;
	/** When `begin` last ran this cycle: notes added before it are delivered. */
	beganAt?: number;
}

/** The whole status from the journal plus the cycle in flight; `active:false` when this session is no run. */
export function buildStatus(entries: readonly JournalEntry[], now: number, live?: LiveCycle): AutopilotStatus {
	const state = lastStateEntry(entries);
	if (!state) return { active: false };
	const records = cycleRecords(entries);
	const running = state.state === "running" || state.state === "stopping";
	const activeMs = state.activeMs + (running ? Math.max(0, now - state.at) : 0);
	const cycle = Math.max(records.at(-1)?.n ?? 0, live?.n ?? 0);
	return {
		active: true,
		role: state.role ?? "parent",
		state: state.state,
		...(state.reason ? { reason: state.reason } : {}),
		...(state.detail ? { detail: state.detail } : {}),
		run: state.run,
		root: state.root,
		branch: state.branch,
		baseBranch: state.baseBranch,
		...(state.target ? { target: state.target } : {}),
		cycle,
		...(live
			? {
					now: {
						n: live.n,
						...(live.area ? { area: live.area } : {}),
						...(live.title ? { title: live.title } : {}),
						startedAt: live.startedAt,
					},
				}
			: {}),
		startedAt: state.startedAt,
		activeMs,
		settings: state.settings,
		cycles: records,
		...(redStreak(records) > 0 ? { redStreak: redStreak(records) } : {}),
		backlog: backlogItems(entries),
		notes: pendingNotes(entries, records, live?.beganAt),
		ship: {
			policy: state.settings.ship,
			queue: [],
			...(state.inFlight ? { inFlight: state.inFlight } : {}),
			...(state.release ? { release: state.release } : {}),
			...(state.releaseProcedure ? { releaseProcedure: state.releaseProcedure } : {}),
			...(state.releaseBlocked ? { releaseBlocked: state.releaseBlocked } : {}),
		},
		totals: { ...totalsOf(records), ...hourlyRates(records) },
		children: [],
		...(state.quotaResetAt ? { quotaResetAt: state.quotaResetAt } : {}),
	};
}

/** A fresh state entry for a run that is just starting (`arm` without `resume`). */
export function initialStateEntry(params: {
	run: string;
	root: string;
	branch: string;
	baseBranch: string;
	target?: string;
	settings?: AutopilotSettings;
	role?: "parent" | "child";
	excludedTools: string[];
	now: number;
}): AutopilotStateEntry {
	return {
		state: "running",
		run: params.run,
		root: params.root,
		branch: params.branch,
		baseBranch: params.baseBranch,
		...(params.target ? { target: params.target } : {}),
		settings: params.settings ?? DEFAULT_AUTOPILOT_SETTINGS,
		startedAt: params.now,
		activeMs: 0,
		excludedTools: params.excludedTools,
		...(params.role === "child" ? { role: "child" as const } : {}),
		at: params.now,
	};
}
