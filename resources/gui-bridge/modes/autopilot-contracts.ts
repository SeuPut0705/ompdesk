/**
 * Dependency-free Autopilot contracts shared by main, the renderer and the packaged bridge
 * (design: the Autopilot document, §2-§4 and §9). Autopilot is a stock Goal with a marker: the
 * bridge keeps the cycle ledger in the session journal, main runs the coordinator, the renderer
 * shows it. Nothing here imports anything: types, constants and pure helpers only.
 *
 * UI name: "Autopilot" (ko "오토파일럿"); every code id stays `autopilot`.
 */

// ---------------------------------------------------------------------------------------------
// Journal entry types (`sessionManager.appendCustomEntry`)
// ---------------------------------------------------------------------------------------------

/** started | stopping | paused | ended, with the settings in force (the last one wins). */
export const AUTOPILOT_STATE_ENTRY = "ompdesk.autopilot";
/** One finished cycle: the autopilot log. */
export const AUTOPILOT_CYCLE_ENTRY = "ompdesk.autopilot-cycle";
/** A user instruction for the next cycle (`begin.notes` consumes it once). */
export const AUTOPILOT_NOTE_ENTRY = "ompdesk.autopilot-note";
/** A pinned backlog item: add | remove | done. */
export const AUTOPILOT_BACKLOG_ENTRY = "ompdesk.autopilot-backlog";
/** A verified "push now" / "release now" request from the user's own chat message. */
export const AUTOPILOT_SHIP_REQUEST_ENTRY = "ompdesk.autopilot-ship-request";
/** What the ShipRunner (main) did: pushes, merges, reverts. The audit allows exactly these. */
export const AUTOPILOT_SHIP_ACTION_ENTRY = "ompdesk.autopilot-ship-action";
/** Marks a child session this run opened. */
export const AUTOPILOT_CHILD_ENTRY = "ompdesk.autopilot-child";

// ---------------------------------------------------------------------------------------------
// States and reasons
// ---------------------------------------------------------------------------------------------

export const AUTOPILOT_STATES = ["running", "stopping", "paused", "waiting_quota", "ended"] as const;
export type AutopilotState = (typeof AUTOPILOT_STATES)[number];

/**
 * Why the run is paused (it can be resumed). Only what the user asked for (Pause, Stop now, a ceiling they set, Continue
 * interrupted work off), a banned destructive git action and the repository vanishing pause a run: a red cycle, a
 * failed check, a rejected push, a failed release, plan mode, blocked todos or a quiet turn never do (the next cycle
 * repairs them; see `AutopilotNudge`).
 */
export const AUTOPILOT_PAUSE_REASONS = [
	"user_pause",
	"user_abort",
	"ban_violation",
	"repo_gone",
	"budget",
	"time",
	"cycles",
	"cost",
	"app_closed",
] as const;
export type AutopilotPauseReason = (typeof AUTOPILOT_PAUSE_REASONS)[number];

/** Why it ended (it cannot be resumed). */
export const AUTOPILOT_END_REASONS = ["user", "agent_done", "tab_closed"] as const;
export type AutopilotEndReason = (typeof AUTOPILOT_END_REASONS)[number];

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export const AUTOPILOT_AREAS = ["design", "performance", "features", "refactoring", "tests", "bugs", "docs"] as const;
export type AutopilotArea = (typeof AUTOPILOT_AREAS)[number];
/** What `end.area` may also hold besides {@link AUTOPILOT_AREAS}. */
export type AutopilotCycleArea = AutopilotArea | "user" | "release";

export type AutopilotReleaseCadence = { kind: "every"; n: number } | { kind: "agent" };

export type AutopilotShipPolicy = {
	/** Push the autopilot branch after every green cycle (main's ShipRunner). */
	autoPush: boolean;
	autoRelease: { on: boolean; cadence: AutopilotReleaseCadence };
	remote: string;
};

export const DEFAULT_SHIP_POLICY: AutopilotShipPolicy = {
	autoPush: false,
	autoRelease: { on: false, cadence: { kind: "agent" } },
	remote: "origin",
};

/** Start presets of the sheet. */
export const AUTOPILOT_SHIP_PRESETS = ["local", "push", "release"] as const;
export type AutopilotShipPreset = (typeof AUTOPILOT_SHIP_PRESETS)[number];

export function shipPolicyForPreset(preset: AutopilotShipPreset, remote = "origin"): AutopilotShipPolicy {
	return {
		autoPush: preset !== "local",
		autoRelease: { on: preset === "release", cadence: { kind: "agent" } },
		remote,
	};
}

/** Optional ceilings; all off (null) by default: the account quota and the stop rules are the brakes. */
export type AutopilotLimits = {
	tokens: number | null;
	minutes: number | null;
	cycles: number | null;
	usd: number | null;
};

export const NO_LIMITS: AutopilotLimits = { tokens: null, minutes: null, cycles: null, usd: null };

/** `stops` = stops, release outcomes and quota waits (default); `cycles` = also every cycle; `off`. */
export const AUTOPILOT_NOTIFY_MODES = ["stops", "cycles", "off"] as const;
export type AutopilotNotifyMode = (typeof AUTOPILOT_NOTIFY_MODES)[number];

export interface AutopilotSettings {
	/** Areas the cycles focus on; empty = all. */
	focus: AutopilotArea[];
	ship: AutopilotShipPolicy;
	limits: AutopilotLimits;
	/** Child sessions per cycle: `null` = the agent decides, with no cap (default); a number caps it, 0 = no fan-out. */
	maxParallel: number | null;
	notify: AutopilotNotifyMode;
}

export const DEFAULT_AUTOPILOT_SETTINGS: AutopilotSettings = {
	focus: [],
	ship: DEFAULT_SHIP_POLICY,
	limits: NO_LIMITS,
	maxParallel: null,
	notify: "stops",
};

// ---------------------------------------------------------------------------------------------
// Stop rules (thresholds; none of them is a budget)
// ---------------------------------------------------------------------------------------------

/** Seconds after a terminal agent_end in which a new turn must start before the run is nudged. */
export const STALL_SECONDS = 8;
/** The same normalized title in this many recent cycles is not picked again. */
export const DUPLICATE_WINDOW = 30;
export const RECENT_CYCLES = 10;
export const DEFAULT_RELEASE_EVERY = 5;

// ---------------------------------------------------------------------------------------------
// Journal payloads
// ---------------------------------------------------------------------------------------------

/** Payload of {@link AUTOPILOT_STATE_ENTRY}. */
export interface AutopilotStateEntry {
	state: AutopilotState;
	reason?: AutopilotPauseReason | AutopilotEndReason;
	/** Free text for the chip ("quota until 14:20"). */
	detail?: string;
	/** Run id: the date branch suffix, `YYYY-MM-DD` (+ `-N` when taken). */
	run: string;
	/** Worktree root and the branch it is on. */
	root: string;
	branch: string;
	/** The branch the worktree was cut from (the "main" ahead/behind is measured against). */
	baseBranch: string;
	/** The branch Push pushes to (`HEAD:<target>`, fast-forward only) when it differs from `branch`. */
	target?: string;
	settings: AutopilotSettings;
	startedAt: number;
	/** Milliseconds the run was active (paused time excluded) at this entry. */
	activeMs: number;
	/** Tools taken off the session (`ask`) so disarm restores them. */
	excludedTools: string[];
	/** Tools that were `xd://` devices at arm, so disarm presents them as devices again (not top level). */
	mountedTools?: string[];
	/** A push or release is under way: a restart reconciles it before anything else. */
	inFlight?: { kind: "push" | "release"; startedAt: number; sha?: string };
	/** `parent` (default) runs cycles; a `child` is one DeskTools session of a parent's cycle: guarded, never shipping. */
	role?: "parent" | "child";
	/** Waiting for the account quota until this time (ms), with `state: "waiting_quota"`. */
	quotaResetAt?: number;
	/** Main's findings the bridge serves back (`begin.ship`, `get_autopilot`): the detected release procedure, why it is unavailable, the last release run. */
	releaseProcedure?: AutopilotReleaseProcedure;
	releaseBlocked?: string;
	release?: AutopilotReleaseStatus;
	at: number;
}

export const CYCLE_VERIFY = ["green", "red", "skipped"] as const;
export type CycleVerify = (typeof CYCLE_VERIFY)[number];

export interface AutopilotChildReport {
	session: string;
	branch: string;
	outcome: "merged" | "unmerged" | "failed" | "abandoned";
	sha?: string;
}

/** What a cycle changed in the repository, measured by the bridge (`git diff --numstat` from the turn's start to HEAD). */
export interface AutopilotChangeStat {
	files: number;
	added: number;
	removed: number;
	commits: number;
	/** Every changed file is documentation (README, `docs/`, `*.md`...). */
	docOnly?: boolean;
}

/** Why the bridge did not take a green claim as it was: no check command ran, the last one failed, or files were edited after it. */
export interface AutopilotVerifyNote {
	kind: "no_check" | "check_failed" | "edited_after";
	/** `check_failed`: the command that failed. */
	command?: string;
}

/** Payload of {@link AUTOPILOT_CYCLE_ENTRY} (what `autopilot end` reported, plus what the bridge measured). */
export interface AutopilotCycleRecord {
	n: number;
	area: AutopilotCycleArea | "unreported";
	title: string;
	summary: string;
	verify: CycleVerify | "unreported";
	commit?: string;
	backlogId?: string;
	followups: string[];
	ship?: { kind: "release"; version: string; runUrl?: string };
	children: AutopilotChildReport[];
	startedAt: number;
	durationMs: number;
	/** The parent's own tokens and cost this cycle; main adds the children's. */
	tokens: number;
	usd: number;
	compactions: number;
	/** The user reverted it from the screen. */
	reverted?: boolean;
	/** The bridge did not take the reported verify as it was (it shows what the cycle's own tool calls say): why. */
	verifyNote?: AutopilotVerifyNote;
	/** What the cycle changed; absent when it left no commit. */
	change?: AutopilotChangeStat;
}

export interface AutopilotNote {
	id: string;
	text: string;
	at: number;
}

export interface AutopilotBacklogEvent {
	op: "add" | "remove" | "done";
	id: string;
	text?: string;
	/** `done`: the cycle that did it. */
	cycle?: number;
	at: number;
}

export interface AutopilotBacklogItem {
	id: string;
	text: string;
	done: boolean;
	cycle?: number;
}

export const SHIP_KINDS = ["push", "pr", "merge", "release", "revert"] as const;
export type ShipKind = (typeof SHIP_KINDS)[number];
export type ShipItemState = "queued" | "running" | "done" | "failed";

export interface ShipQueueItem {
	id: string;
	kind: ShipKind;
	state: ShipItemState;
	detail?: string;
	url?: string;
	sha?: string;
	/** `revert`: the cycle number. */
	cycle?: number;
	at: number;
}

/** Payload of {@link AUTOPILOT_SHIP_REQUEST_ENTRY}: a verified user request, consumed at the turn's end. */
export interface AutopilotShipRequest {
	kind: "push" | "release";
	/** The user's own words, found verbatim in a real user message. */
	quote: string;
	/** The turn (cycle number) it was made in. */
	cycle: number;
	at: number;
	/** Set on the second entry that marks the request with this `at` as taken (`take_ship_requests`). */
	consumedAt?: number;
}

/** Payload of {@link AUTOPILOT_SHIP_ACTION_ENTRY}: written by main so the audit expects the ref change. */
export interface AutopilotShipAction {
	kind: ShipKind;
	/** Refs the action is allowed to move, e.g. `refs/remotes/origin/autopilot/2026-10-17`, `refs/heads/main`. */
	refs: string[];
	sha?: string;
	at: number;
}

export interface AutopilotReleaseProcedure {
	/** The rules file the procedure was found in, relative to the repo root. */
	file: string;
	/** Headings that anchor it ("Change workflow", "Release"). */
	anchors: string[];
}

export interface AutopilotReleaseStatus {
	version: string;
	runUrl?: string;
	state: "pending" | "success" | "failure";
}

export interface AutopilotShipState {
	policy: AutopilotShipPolicy;
	queue: ShipQueueItem[];
	inFlight?: AutopilotStateEntry["inFlight"];
	release?: AutopilotReleaseStatus;
	releaseProcedure?: AutopilotReleaseProcedure;
	/** Why auto release / the Release button is unavailable (no detected procedure, ...). */
	releaseBlocked?: string;
}

// ---------------------------------------------------------------------------------------------
// The tool (`autopilot`)
// ---------------------------------------------------------------------------------------------

export type AutopilotToolInput =
	| { op: "begin" }
	| { op: "pick"; area: AutopilotCycleArea; title: string }
	| {
			op: "end";
			area: AutopilotCycleArea;
			title: string;
			summary: string;
			verify: CycleVerify;
			commit?: string;
			/** The exact command that ran the repo's check: the runtime looks for it among the cycle's tool calls. */
			check?: string;
			backlogId?: string;
			followups?: string[];
			ship?: { kind: "release"; version: string; runUrl?: string };
			children?: AutopilotChildReport[];
	  }
	| { op: "ship"; kind: "push" | "release"; quote: string }
	| { op: "propose_release" };

export interface AutopilotBeginResult {
	cycle: number;
	focus: AutopilotArea[];
	backlog: AutopilotBacklogItem[];
	notes: AutopilotNote[];
	rotation: {
		suggested: AutopilotArea;
		counts: Record<AutopilotArea, number>;
		lastCycleOfArea: Record<AutopilotArea, number | null>;
	};
	recent: Array<Pick<AutopilotCycleRecord, "n" | "area" | "title" | "verify" | "commit"> & { reverted?: boolean }>;
	openFollowups: string[];
	redStreak: number;
	stopping: boolean;
	ship: {
		autoPush: boolean;
		autoRelease: { on: boolean; cadence: AutopilotReleaseCadence };
		remote: string;
		branch: string;
		due: boolean;
		inFlight?: AutopilotStateEntry["inFlight"];
		releaseProcedure?: AutopilotReleaseProcedure;
	};
	budgetLeft?: Partial<AutopilotLimits>;
	/** The project's guide (AUTOPILOT.md at the worktree root), bounded; absent when the repo has none. Re-read at every `begin`. */
	guide?: { text: string; truncated?: boolean };
	/** Said once per cycle: what to do right after the audit. */
	pick: string;
	/** What the run's own history says about this pick (carried follow-ups, a docs-only last cycle); absent when nothing stands out. */
	hints?: string[];
}

// ---------------------------------------------------------------------------------------------
// Full state (`get_autopilot`) and the update frame (`autopilot_update`)
// ---------------------------------------------------------------------------------------------

export interface AutopilotChildLive {
	tabId: string;
	sessionId?: string;
	area?: string;
	branch?: string;
	status: "running" | "done" | "failed" | "closed";
	sha?: string;
}

export interface AutopilotTotals {
	tokens: number;
	usd: number;
	/** Hourly rates from the last five cycles; absent until there are two. */
	tokensPerHour?: number;
	usdPerHour?: number;
}

/**
 * Where a run commits and pushes. `new` cuts `name` (default `autopilot/<date>`) off the folder's HEAD; `existing`
 * checks out a local branch, or tracks the remote one when there is no local branch (`remote`). The default branch
 * (`main`) is just an existing branch the user picked, with a warning on the sheet.
 */
export type AutopilotBranchChoice =
	| { kind: "new"; name?: string }
	| { kind: "existing"; name: string; remote?: string };

/** One row of the sheet's branch picker. */
export interface AutopilotBranchEntry {
	name: string;
	/** A local branch of that name exists. */
	local: boolean;
	/** The ship remote has a branch of that name. */
	remote: boolean;
	/** The repository's default branch. */
	default: boolean;
	/** Checked out in the user's own folder. */
	current: boolean;
	/** The worktree that already has it checked out (a run cannot take it); absent when free. */
	checkedOutAt?: string;
}

/** What the start sheet's branch picker needs of a repository. */
export interface AutopilotBranchInfo {
	/** The repository's top level; the key of the remembered choice. */
	repo: string;
	/** The ship remote the remote-only branches come from. */
	remote: string;
	defaultBranch: string | null;
	/** The name a new branch gets unless the user edits it (`autopilot/<date>`, free of clashes). */
	suggested: string;
	branches: AutopilotBranchEntry[];
	/** The choice remembered for this repository, when it is still usable. */
	last?: AutopilotBranchChoice;
}

export interface AutopilotStatus {
	/** False: this session is not an autopilot run (the other fields are absent). */
	active: boolean;
	/** `parent` runs cycles; a `child` is a DeskTools session a parent's cycle opened (absent when inactive). */
	role?: "parent" | "child";
	state?: AutopilotState;
	reason?: AutopilotPauseReason | AutopilotEndReason;
	detail?: string;
	run?: string;
	root?: string;
	branch?: string;
	baseBranch?: string;
	target?: string;
	cycle?: number;
	/** The cycle in flight, set by `begin` and cleared by the cycle's record. */
	now?: { n: number; area?: AutopilotCycleArea; title?: string; startedAt: number };
	startedAt?: number;
	activeMs?: number;
	settings?: AutopilotSettings;
	cycles?: AutopilotCycleRecord[];
	/** Red cycles in a row (the repair counter the timeline shows); absent at zero. The run goes on: the next cycle repairs. */
	redStreak?: number;
	backlog?: AutopilotBacklogItem[];
	notes?: AutopilotNote[];
	ship?: AutopilotShipState;
	/** A session that is no run: the repo's guide, or a draft of one (`ship` stays what the sheet needs). */
	guide?: AutopilotGuideInfo;
	/** A session that is no run: the branches the sheet's picker offers (this folder's repository). */
	branches?: AutopilotBranchInfo;
	totals?: AutopilotTotals;
	children?: AutopilotChildLive[];
	/** Waiting for the account quota until this time (ms). */
	quotaResetAt?: number;
}

/** Frame body of `autopilot_update`: the whole status (the screen is small; no diffing). */
export type AutopilotUpdate = AutopilotStatus;

/**
 * Bridge → main frame `autopilot_nudge`: no turn started after a cycle although the goal wants one (plan mode on, every
 * todo blocked, a quiet turn). The run is never paused for it: main leaves plan mode and asks for the next cycle.
 */
export type AutopilotNudgeReason = "plan" | "blocked" | "no_progress";

/** Bridge → main frame asking for a pause (a ceiling the user set) or an end; main sends stock `set_goal pause`. */
export interface AutopilotStopRequest {
	reason: AutopilotPauseReason | AutopilotEndReason;
	detail?: string;
	/** `ended`: the run is over; otherwise paused. */
	end?: boolean;
}

/** Bridge → main frame once the last turn of a stopping run settled (main closes children, drops the goal). */
export interface AutopilotSettled {
	reason: AutopilotPauseReason | AutopilotEndReason;
}

// ---------------------------------------------------------------------------------------------
// Commands (renderer → main; `set_autopilot` action union is mirrored in shared/rpc-types.ts)
// ---------------------------------------------------------------------------------------------

export type AutopilotStartOptions = {
	focus?: AutopilotArea[];
	preset?: AutopilotShipPreset;
	ship?: Partial<AutopilotShipPolicy>;
	limits?: Partial<AutopilotLimits>;
	maxParallel?: number;
	notify?: AutopilotNotifyMode;
	backlog?: string[];
	/** The guide text to commit as the autopilot branch's first commit when the new worktree's AUTOPILOT.md differs (or is missing). */
	guide?: string;
	/** Where the run commits and pushes; absent: a new `autopilot/<date>` branch. */
	branch?: AutopilotBranchChoice;
};

export type AutopilotAction =
	| ({ action: "start" } & AutopilotStartOptions)
	| { action: "guide_draft" }
	| { action: "stop" }
	| { action: "abort" }
	| { action: "pause" }
	| { action: "resume" }
	| {
			action: "configure";
			focus?: AutopilotArea[];
			ship?: Partial<AutopilotShipPolicy>;
			limits?: Partial<AutopilotLimits>;
			notify?: AutopilotNotifyMode;
	  }
	| { action: "note"; text: string }
	| { action: "backlog_add"; text: string }
	| { action: "backlog_remove"; id: string }
	| {
			action: "ship";
			kind: ShipKind | "auto_push" | "auto_release";
			enabled?: boolean;
			cycle?: number;
			mode?: "ff" | "merge_commit";
	  }
	| { action: "cancel_ship"; id: string };

// ---------------------------------------------------------------------------------------------
// Child sessions
// ---------------------------------------------------------------------------------------------

/** Payload of {@link AUTOPILOT_CHILD_ENTRY} in a child's journal. */
export interface AutopilotChildEntry {
	root: string;
	parentTab: string;
	run: string;
	area?: string;
}

/** DeskTools' spawn tag for a child opened by a run. */
export const AUTOPILOT_CHILD_TAG = "autopilot-child";

// ---------------------------------------------------------------------------------------------
// Constants for the objective, the tools and the branch name
// ---------------------------------------------------------------------------------------------

/** The per-project Autopilot guide: project-wide direction in the repo's own root, read at every `begin` from the run's worktree. */
export const AUTOPILOT_GUIDE_FILE = "AUTOPILOT.md";
/** What `begin` passes on of the guide (bytes); a longer file is cut with a marker. */
export const AUTOPILOT_GUIDE_MAX_BYTES = 8 * 1024;
/** What the start sheet loads of a guide to edit it (bytes); a longer file is shown read-only. */
export const AUTOPILOT_GUIDE_SHEET_MAX_BYTES = 64 * 1024;

/** The guide as the start sheet shows it (`get_autopilot` / `guide_draft` on a session that is no run). */
export interface AutopilotGuideInfo {
	/** The repo's checkout has an AUTOPILOT.md. */
	exists: boolean;
	/** The file's text, or the draft when there is no file. */
	text: string;
	/** The file exceeds the sheet's limit: `text` is empty and the guide is not editable here. */
	tooLarge?: boolean;
	/** Where a draft came from: one smol-role request, or the deterministic template. */
	draft?: "model" | "template";
	/** What the draft's one model request cost (a model draft only): the smol model that answered, dollars and tokens. */
	cost?: { model: string; usd?: number; tokens?: number };
}

/** The fixed Goal objective (<= 300 characters; focus and settings reach the agent only through `begin`). */
export const AUTOPILOT_OBJECTIVE =
	"Autopilot: keep developing this project across all areas. Run one autopilot cycle per turn exactly as the autopilot section says. NEVER call goal complete; the user ends this.";

export const AUTOPILOT_TOOL = "autopilot";
export const AUTOPILOT_PROMPT_SECTION = "autopilot";
export const AUTOPILOT_CHILD_PROMPT_SECTION = "autopilot-child";

/** `autopilot/<run>` where run is `YYYY-MM-DD`. */
export const AUTOPILOT_BRANCH_PREFIX = "autopilot/";

export function autopilotBranch(run: string): string {
	return `${AUTOPILOT_BRANCH_PREFIX}${run}`;
}

/** A child's branch: `autopilot/<run>-c<N>-<area>` (never under `autopilot/<run>/`: git cannot hold a branch and a directory of that name). */
export function autopilotChildBranch(run: string, cycle: number, area: string): string {
	return `${AUTOPILOT_BRANCH_PREFIX}${run}-c${cycle}-${
		area
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "work"
	}`;
}

export function isAutopilotArea(value: unknown): value is AutopilotArea {
	return (AUTOPILOT_AREAS as readonly unknown[]).includes(value);
}

/** The prefs keys (main prefs store, written through `prefs.set`). */
export const AUTOPILOT_SHIP_PREF = "autopilotShip";
export const AUTOPILOT_NOTIFY_PREF = "autopilotNotify";
/**
 * The last branch choice per repository, `{ [repo top level]: AutopilotBranchChoice }`. Not part of `autopilotShip`:
 * the branch is per run, this only prefills the next sheet.
 */
export const AUTOPILOT_BRANCH_PREF = "autopilotBranch";

// ---------------------------------------------------------------------------------------------
// Bridge protocol (main <-> bridge; owned by the bridge slice, mirrored by the fake omp)
// ---------------------------------------------------------------------------------------------

/** Bridge methods main calls through `ctx.bridge.request`. All resolve to the fresh {@link AutopilotStatus} unless noted. */
export const AUTOPILOT_BRIDGE_METHODS = {
	/** {@link AutopilotArmParams}: journal `running` (or the resume), install overrides, tools, guard, prompt section. Completes before main sends `set_goal create|resume`. */
	arm: "modes.autopilot_arm",
	/** `{}`: the whole status from the journal (+ the cycle in flight). `active:false` when this session is no run. */
	status: "modes.autopilot_status",
	/** {@link AutopilotConfigureParams}: settings and the facts main found; takes effect at the next `begin`. */
	configure: "modes.autopilot_configure",
	/** `{text}`: a user instruction `begin.notes` consumes once. */
	note: "modes.autopilot_note",
	/** {@link AutopilotBacklogParams}. */
	backlog: "modes.autopilot_backlog",
	/** {@link AutopilotSetStateParams}: main journals pauses, stopping, ended, waiting_quota. `stopping` also steers the agent. */
	setState: "modes.autopilot_set_state",
	/** {@link AutopilotShipAction} minus `at`: the ShipRunner's own ref moves, journaled for the audit. */
	shipAction: "modes.autopilot_ship_action",
	/** `{cycle}`: marks the cycle reverted. */
	markReverted: "modes.autopilot_mark_reverted",
	/** `{}` -> {@link AutopilotTakeShipRequestsResult}: verified user push/release requests not yet consumed. Consumed means gone. */
	takeShipRequests: "modes.autopilot_take_ship_requests",
	/** {@link AutopilotCycleAmendParams}: adds the children's usage and reports to a finished cycle. */
	cycleAmend: "modes.autopilot_cycle_amend",
	/** `{}`: restore tools/overrides, journal `ended` (the state main passed to `setState` first stays the reason). */
	disarm: "modes.autopilot_disarm",
	/** `{root, draft?}` -> {@link AutopilotGuideInfo}: the checkout's AUTOPILOT.md; with `draft` and no file, one smol-role draft (template on failure). Works on any session. */
	guide: "modes.autopilot_guide",
} as const;

export interface AutopilotArmParams {
	role: "parent" | "child";
	/** Worktree root. */
	root: string;
	run: string;
	branch: string;
	baseBranch: string;
	/** The branch Push pushes to when it is not `branch` itself (the run works on its own branch off a target another worktree holds). */
	target?: string;
	settings: AutopilotSettings;
	/** Child: the opening parent tab. */
	parentTab?: string;
	/** Child: its area. */
	area?: string;
	/** True when the run already has a journal (restart / resume): keep cycle numbers and history. */
	resume?: boolean;
	releaseProcedure?: AutopilotReleaseProcedure;
	releaseBlocked?: string;
}

export interface AutopilotConfigureParams {
	focus?: AutopilotArea[];
	ship?: Partial<AutopilotShipPolicy>;
	limits?: Partial<AutopilotLimits>;
	notify?: AutopilotNotifyMode;
	/** `null` clears. */
	releaseProcedure?: AutopilotReleaseProcedure | null;
	releaseBlocked?: string | null;
	release?: AutopilotReleaseStatus | null;
}

export type AutopilotBacklogParams = { op: "add"; text: string } | { op: "remove"; id: string };

export interface AutopilotSetStateParams {
	state: AutopilotState;
	reason?: AutopilotPauseReason | AutopilotEndReason;
	detail?: string;
	/** `null` clears the in-flight mark; a push neither replaces nor clears a release mark (`inFlightAfter`). */
	inFlight?: AutopilotStateEntry["inFlight"] | null;
	quotaResetAt?: number;
}

export type AutopilotShipActionParams = Omit<AutopilotShipAction, "at">;

export interface AutopilotTakeShipRequestsResult {
	requests: AutopilotShipRequest[];
}

export interface AutopilotCycleAmendParams {
	n: number;
	/** Added to the cycle's tokens / usd. */
	tokens?: number;
	usd?: number;
	children?: AutopilotChildReport[];
}

/** Frames the bridge pushes (`ctx.bridge` events / sidecar frames). `autopilot_update` also reaches the renderer as an RpcEvent. */
export const AUTOPILOT_FRAME_TYPES = [
	"autopilot_update",
	"autopilot_cycle_end",
	"autopilot_nudge",
	"autopilot_stop_requested",
	"autopilot_settled",
] as const;
export type AutopilotFrameType = (typeof AUTOPILOT_FRAME_TYPES)[number];

export type AutopilotFrame =
	| { type: "autopilot_update"; status: AutopilotStatus }
	/** The terminal `agent_end` of a cycle: main audits, then runs the ShipRunner (push after green, queued items). */
	| { type: "autopilot_cycle_end"; record: AutopilotCycleRecord }
	/** No turn started after a cycle although the goal wants one: main asks for the next cycle (never a pause). */
	| { type: "autopilot_nudge"; reason: AutopilotNudgeReason }
	| ({ type: "autopilot_stop_requested" } & AutopilotStopRequest)
	| ({ type: "autopilot_settled" } & AutopilotSettled);

/** What the tool guard decides; shared by the bridge guard, main's approver and main's audit. */
export type AutopilotShipLevel = "local" | "push" | "release";
