/**
 * Autopilot's pure rules: rotation, duplicate prevention, the cycle classification (red / no commit /
 * no report / churn / stall), release due-ness, quote verification, the status built from the journal.
 * No omp imports (not even types): the GUI's vitest loads this file directly
 * (src/main/bridge-autopilot-core.test.ts); ./autopilot.ts wires it to the session.
 */
import { AGENT_MESSAGE_START } from "../agent-control-contracts";
import {
	AUTOPILOT_AREAS,
	AUTOPILOT_CYCLE_ENTRY,
	AUTOPILOT_DISMISS_ENTRY,
	AUTOPILOT_GUIDE_MAX_BYTES,
	AUTOPILOT_NOTE_ENTRY,
	AUTOPILOT_SHIP_REQUEST_ENTRY,
	AUTOPILOT_STATE_ENTRY,
	type AutopilotArea,
	type AutopilotBeginResult,
	type AutopilotChangeStat,
	type AutopilotCycleArea,
	type AutopilotCycleRecord,
	type AutopilotDismissEvent,
	type AutopilotLimits,
	type AutopilotNote,
	type AutopilotNudgeReason,
	type AutopilotPauseReason,
	type AutopilotSetStateParams,
	type AutopilotSettings,
	type AutopilotShipLevel,
	type AutopilotShipPolicy,
	type AutopilotShipRequest,
	type AutopilotStateEntry,
	type AutopilotStatus,
	type AutopilotStopRequest,
	type AutopilotToolInput,
	type AutopilotVerifyNote,
	clipCycleSummary,
	DEFAULT_AUTOPILOT_SETTINGS,
	DUPLICATE_WINDOW,
	isAutopilotArea,
	normalizeTitle,
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

/** A commit since the project's last release: its subject and commit time. */
export interface UnreleasedCommit {
	subject: string;
	at: number;
}

/** User-visible changes that make a release worth it without anything urgent among them. */
export const RELEASE_BATCH = 3;
/** A user-visible change never waits longer than this for the next release, however few have gathered. */
export const RELEASE_WAIT_CEILING_MS = 24 * 60 * 60_000;

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?(!)?:\s/;
const USER_VISIBLE_TYPES = new Set(["feat", "fix", "perf"]);

/**
 * Whether what landed since the last release is worth one, by its content, never by the clock since the last release
 * (the user's call, 22 Oct 2026: "once or twice a day" made a run sit on a batch of fixes for hours). A user-visible
 * change is a `feat`, `fix` or `perf` commit (or a breaking `!` one); in a repository that does not write
 * conventional commits every commit counts. Due: an urgent one (the agent says why: a defect that breaks the released
 * product, a regression of the last release), or {@link RELEASE_BATCH} user-visible changes, or one that has waited
 * {@link RELEASE_WAIT_CEILING_MS}. Docs, tests, refactors and CI alone never are.
 */
export function releaseReadiness(
	commits: readonly UnreleasedCommit[],
	now: number,
	urgent?: string,
): { due: boolean; reason: string; userVisible: string[]; internal: number } {
	const own = commits.filter(commit => !/^release:/i.test(commit.subject) && !/^Merge /.test(commit.subject));
	const conventional = own.filter(commit => CONVENTIONAL.test(commit.subject)).length;
	const counts = (subject: string): boolean => {
		if (conventional * 2 < own.length) return true;
		const match = CONVENTIONAL.exec(subject);
		return match !== null && (USER_VISIBLE_TYPES.has(match[1]?.toLowerCase() ?? "") || match[2] === "!");
	};
	const visible = own.filter(commit => counts(commit.subject));
	const userVisible = visible.map(commit => commit.subject);
	const internal = own.length - visible.length;
	if (visible.length === 0)
		return {
			due: false,
			reason: "nothing user-visible since the last release (docs, tests, refactors and CI wait for the next one)",
			userVisible,
			internal,
		};
	if (urgent?.trim()) return { due: true, reason: `urgent: ${urgent.trim()}`, userVisible, internal };
	if (visible.length >= RELEASE_BATCH)
		return {
			due: true,
			reason: `${visible.length} user-visible changes since the last release`,
			userVisible,
			internal,
		};
	const oldest = Math.min(...visible.map(commit => commit.at));
	if (now - oldest >= RELEASE_WAIT_CEILING_MS)
		return { due: true, reason: "a user-visible change has waited a day for a release", userVisible, internal };
	return {
		due: false,
		reason: `${visible.length} user-visible change${visible.length === 1 ? "" : "s"} since the last release; a release takes ${RELEASE_BATCH}, an urgent one, or a change that has waited a day`,
		userVisible,
		internal,
	};
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
	return policy.autoPush || policy.land === true ? "push" : "local";
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

/**
 * What main's `setState` changes in the journal's state. A change that names no state (a push's in-flight mark)
 * keeps the journal's own: main's last read can be older than a pause the user just gave.
 */
export function setStatePatch(
	params: AutopilotSetStateParams,
	prev: AutopilotStateEntry,
): Partial<Omit<AutopilotStateEntry, "at" | "activeMs">> {
	return {
		...(params.state !== undefined ? { state: params.state } : {}),
		...(params.reason ? { reason: params.reason } : {}),
		...(params.detail ? { detail: params.detail } : {}),
		...(params.quotaResetAt ? { quotaResetAt: params.quotaResetAt } : {}),
		...(params.inFlight !== undefined ? { inFlight: inFlightAfter(prev.inFlight, params.inFlight) } : {}),
	};
}

// ---------------------------------------------------------------------------------------------
// "Push now" / "release now" quotes
// ---------------------------------------------------------------------------------------------

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
	return text.trim() === "" || AGENT_MESSAGE_START.test(text) ? undefined : text;
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
			...((typeof ship.land === "boolean" ? ship.land : base.ship.land) ? { land: true } : {}),
			...((typeof ship.automatic === "boolean" ? ship.automatic : base.ship.automatic) ? { automatic: true } : {}),
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
		maxParallel:
			typeof patch.maxParallel === "number" && Number.isFinite(patch.maxParallel)
				? Math.max(0, Math.round(patch.maxParallel))
				: patch.maxParallel === null
					? null
					: base.maxParallel,
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

/** True while the journal's last Autopilot state entry is running or stopping (a run's parent or a child session). */
export function autopilotRunning(entries: readonly JournalEntry[]): boolean {
	const state = lastStateEntry(entries)?.state;
	return state === "running" || state === "stopping";
}

/** Every cycle record, one per cycle number: a later entry with the same `n` (an amendment, a revert mark) replaces the earlier one. */
export function cycleRecords(entries: readonly JournalEntry[]): AutopilotCycleRecord[] {
	const byNumber = new Map<number, AutopilotCycleRecord>();
	for (const record of customEntries<AutopilotCycleRecord>(entries, AUTOPILOT_CYCLE_ENTRY)) {
		if (typeof record.n === "number") byNumber.set(record.n, record);
	}
	return [...byNumber.values()].sort((a, b) => a.n - b.n);
}

/** The follow-ups the person dismissed, in order. */
export function followupDismissals(entries: readonly JournalEntry[]): { text: string; at: number }[] {
	return customEntries<AutopilotDismissEvent>(entries, AUTOPILOT_DISMISS_ENTRY).flatMap(event =>
		event.op === "dismiss" && event.text ? [{ text: event.text, at: event.at }] : [],
	);
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

/**
 * Follow-ups of the run's cycles that no later cycle did, newest first, without repeats. A later cycle did one when
 * its title is the follow-up's text or its report lists it under `resolved` (a title is a short name for the work and
 * almost never repeats a follow-up's sentence, so without `resolved` a finished follow-up stayed open for the whole
 * window and `begin` kept pointing the agent back at it). The person's dismissal after the cycle that left it ended
 * closes it too (`dismissed`); a cycle that lists it again reopens it, even one that was already running when the
 * person dismissed it.
 */
export function openFollowups(
	records: readonly AutopilotCycleRecord[],
	dismissed: readonly { text: string; at: number }[] = [],
): string[] {
	return openFollowupsLeft(records, dismissed).map(item => item.text);
}

/** {@link openFollowups} with the newest cycle that left each one (the board shows how long it has waited). */
export function openFollowupsLeft(
	records: readonly AutopilotCycleRecord[],
	dismissed: readonly { text: string; at: number }[] = [],
): { text: string; cycle: number }[] {
	// Every cycle of the run, not the duplicate check's recent window: a follow-up nobody did or dismissed stays open
	// however long ago it was left (30 cycles on, an unfinished one used to leave the list without a word).
	const window = records;
	const open: { text: string; cycle: number }[] = [];
	const seen = new Set<string>();
	for (let i = window.length - 1; i >= 0; i--) {
		for (const followup of window[i].followups ?? []) {
			const key = normalizeTitle(followup);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			const done = (later: AutopilotCycleRecord) =>
				normalizeTitle(later.title) === key || (later.resolved ?? []).some(text => normalizeTitle(text) === key);
			if (window.slice(i + 1).some(done)) continue;
			// After the cycle that left it ended: a dismissal while that cycle still ran is about an earlier listing.
			const left = window[i].startedAt + window[i].durationMs;
			if (dismissed.some(event => event.at >= left && normalizeTitle(event.text) === key)) continue;
			open.push({ text: followup, cycle: window[i].n });
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
	/** The check command that made the cycle green (see `judgeVerify`). */
	checkCommand?: string;
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
		followups: (report.followups ?? []).map(text => text.trim()).filter(Boolean),
		...(report.resolved?.length ? { resolved: report.resolved.map(text => text.trim()).filter(Boolean) } : {}),
		...(report.ship ? { ship: report.ship } : {}),
		children: report.children ?? [],
		...(facts.verifyNote ? { verifyNote: facts.verifyNote } : {}),
		...(facts.change ? { change: facts.change } : {}),
		...(facts.checkCommand && report.verify === "green" ? { checkCommand: facts.checkCommand } : {}),
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
	if (Array.isArray(input.followups))
		report.followups = input.followups.filter((x): x is string => typeof x === "string");
	if (Array.isArray(input.resolved))
		report.resolved = input.resolved.filter((x): x is string => typeof x === "string");
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
	/** Follow-ups the person dismissed ({@link followupDismissals}). */
	dismissed?: readonly { text: string; at: number }[];
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
	'After the audit and before any edit: autopilot({op:"pick", area, title}). Rank: a known bug or failing behaviour (an open follow-up, a failing check, one you just found) first, then features and refactors, then tests, docs and polish last. It shows the item in the panel and refuses a title that repeats a recent cycle, and a docs pick right after a docs-only cycle unless you pass `reason`. A bug you find and can fix is never written off as a "known limitation": fix it now, or put it in followups so it is the next pick. In `end`, give the commit hash and `check`, the exact command you ran as the repo\'s check.';

/** Words that mark a follow-up or report as a defect rather than a wish. */
const DEFECT =
	/\b(bug|broken|break(s|ing)?|fail(s|ed|ing)?|wrong|incorrect|crash(es)?|regression|error)\b|버그|오류|실패|깨져/i;
/** A report that writes a found problem off instead of fixing it. */
const WRITE_OFF =
	/\b(known (limitation|issue)|limitation|left (as is|unchanged|unfixed)|not fixed|won'?t fix)\b|알려진 (한계|제한)|제한 사항/i;

/** Whether `record` changed documentation only (or reported docs with no change measured). */
function docsOnly(record: AutopilotCycleRecord | undefined): boolean {
	return (
		record !== undefined &&
		record.area !== "unreported" &&
		(record.change?.docOnly === true || (record.area === "docs" && !record.change))
	);
}

/** `pick`'s refusal of a docs item right after a docs-only cycle, or null; a stated `reason` lifts it. */
export function docsPickRefusal(
	records: readonly AutopilotCycleRecord[],
	area: string,
	reason: string | undefined,
): string | null {
	if (area !== "docs" || !docsOnly(records.at(-1)) || (reason ?? "").trim() !== "") return null;
	return "The last cycle changed documentation only: pick a bug, a feature or a test, or pick docs again with `reason` saying why nothing else is worth doing.";
}

/** What `end` tells the agent when its report writes a problem off as a limitation and carries no follow-up for it. */
export function writeOffNote(report: { title: string; summary: string; followups?: readonly string[] }): string | null {
	if (!WRITE_OFF.test(`${report.title}\n${report.summary}`) || (report.followups?.length ?? 0) > 0) return null;
	return "This report calls a problem a limitation. If it is fixable, it is a bug: call end again with it in followups so the next cycle picks it first.";
}

/**
 * How many cycles `text` has been open (case, punctuation and spacing ignored): from the first cycle that left it after
 * the last one that did or resolved it, through the newest cycle. A follow-up left once and never listed again ages
 * too: counting only cycles that listed it again in a row kept such a one at 0, so `begin` never asked for a decision
 * and the run's list only grew.
 */
export function followupAge(records: readonly AutopilotCycleRecord[], text: string): number {
	const key = normalizeTitle(text);
	let first = -1;
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (
			normalizeTitle(record.title) === key ||
			(record.resolved ?? []).some(resolved => normalizeTitle(resolved) === key)
		)
			break;
		if ((record.followups ?? []).some(followup => normalizeTitle(followup) === key)) first = i;
	}
	return first < 0 ? 0 : records.length - first;
}

/** What the run's own history says about this pick: follow-ups carried too long, a docs-only last cycle, fan-out cost. */
export function beginHints(
	records: readonly AutopilotCycleRecord[],
	facts: { open: readonly string[]; maxParallel: number | null },
): string[] {
	const hints: string[] = [];
	const carried = facts.open
		.map(text => ({ text, age: followupAge(records, text) }))
		.filter(item => item.age >= CARRIED_FOLLOWUP_CYCLES)
		.sort((a, b) => b.age - a.age)
		.slice(0, 2);
	for (const { text, age } of carried) {
		hints.push(
			`The follow-up "${text}" has been open for ${age} cycles: do it now if the guide ranks it in scope; if it is done, no longer applies or is not worth doing, list its exact text in end.resolved and say why in the summary, before another small finding.`,
		);
	}
	const defects = facts.open.filter(text => DEFECT.test(text)).slice(0, 2);
	if (defects.length > 0) {
		hints.push(
			`Open follow-ups name a defect (${defects.map(text => `"${text}"`).join(", ")}): pick one before docs, tests or polish. One you finished or found not to apply goes in end.resolved (its exact text), so it closes.`,
		);
	}
	if (docsOnly(records.at(-1))) {
		hints.push("The last cycle changed documentation only: pick code, tests or a bug unless nothing else is left.");
	}
	if (facts.maxParallel !== 0 && facts.open.length >= 2) {
		hints.push(
			"Child sessions pay only when each item takes several minutes: a child costs about 20 s of set-up and its own copy of the context. Run small independent items side by side as the task tool's subagents in this worktree instead, each on its own files.",
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
	const open = openFollowups(records, facts.dismissed);
	const hints = beginHints(records, { open, maxParallel: settings.maxParallel });
	return {
		cycle: facts.cycle,
		focus: settings.focus,
		notes: [...facts.notes],
		rotation: rotation(records, settings.focus),
		recent,
		openFollowups: open,
		redStreak: redStreak(records),
		stopping: facts.stopping,
		ship: {
			autoPush: settings.ship.autoPush,
			...(settings.ship.land ? { land: true } : {}),
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

/**
 * A cycle as the status carries it: without the check command (main lands from the cycle-end frame's own record) and
 * the follow-ups it closed (`begin` reads them from the journal), and its summary clipped as the Markdown log clips it
 * (the cycle's tooltip is the only other reader). The whole status goes to every window and paired device on each
 * update; on a 67-cycle run those two were 30 % of its 111 KB, and a 73-cycle run's summaries 63 KB (41 KB clipped).
 */
function statusCycle({
	checkCommand: _check,
	resolved: _resolved,
	...cycle
}: AutopilotCycleRecord): AutopilotCycleRecord {
	return { ...cycle, summary: clipCycleSummary(cycle.summary) };
}

/** The whole status from the journal plus the cycle in flight; `active:false` when this session is no run. */
export function buildStatus(entries: readonly JournalEntry[], now: number, live?: LiveCycle): AutopilotStatus {
	const state = lastStateEntry(entries);
	if (!state) return { active: false };
	const records = cycleRecords(entries);
	const running = state.state === "running" || state.state === "stopping";
	const activeMs = state.activeMs + (running ? Math.max(0, now - state.at) : 0);
	const cycle = Math.max(records.at(-1)?.n ?? 0, live?.n ?? 0);
	const left = openFollowupsLeft(records, followupDismissals(entries));
	const followups = left.map(item => item.text);
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
		cycles: records.map(statusCycle),
		...(redStreak(records) > 0 ? { redStreak: redStreak(records) } : {}),
		...(followups.length > 0 ? { followups, followupCycles: left.map(item => item.cycle) } : {}),
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
