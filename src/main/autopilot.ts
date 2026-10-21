/**
 * Autopilot's coordinator (main process). Autopilot is a stock Goal with a marker: the bridge keeps the cycle
 * ledger in the session journal and enforces the protocol inside the agent (modes/autopilot.ts); this class
 * does what only main can:
 *
 * - start: preflight, a new worktree as a new tab on the branch the user picked (a new `autopilot/<date>` by default;
 *   an existing local or remote branch, refused when another worktree has it; the default branch only when picked),
 *   arm the bridge, then stock
 *   `set_goal create` (the arm comes first: stock keeps the tool set at that moment for pause/resume);
 * - stop: pause the goal, tell the bridge `stopping`, empty the children's queues, and when the last turn has
 *   settled close the children, drop the goal and disarm. ■ aborts the running children too;
 * - each cycle's end (`autopilot_cycle_end`): fold the children's usage in and close them, audit git,
 *   run the ShipRunner (push after green, the screen's queue), follow a release run;
 * - the stop rules the bridge reports (`autopilot_stop_requested`) become a stock pause, errors/quota stay
 *   with TurnResume and the renderer, a restart resumes the run (after TurnResume's restore of the cut-off turn);
 * - answers the approval cards of autopilot tabs (autopilot-approver.ts), overlays children and the ship
 *   queue on the bridge's `autopilot_update`, notifies.
 *
 * Everything the coordinator knows about a run is rebuilt from the bridge's journal (`modes.autopilot_status`);
 * what it keeps in memory (ship queue, children, audit baseline) is only what the journal cannot hold.
 */
import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	AUTOPILOT_BRIDGE_METHODS,
	AUTOPILOT_CHILD_TAG,
	AUTOPILOT_GUIDE_COMMIT_MAX_BYTES,
	AUTOPILOT_GUIDE_FILE,
	AUTOPILOT_OBJECTIVE,
	type AutopilotAction,
	type AutopilotArea,
	type AutopilotArmParams,
	type AutopilotBranchChoice,
	type AutopilotBranchEntry,
	type AutopilotChildLive,
	type AutopilotCycleRecord,
	type AutopilotEndReason,
	type AutopilotEnsuredGuide,
	type AutopilotNudgeReason,
	type AutopilotPauseReason,
	type AutopilotReleaseProcedure,
	type AutopilotSettings,
	type AutopilotShipPolicy,
	type AutopilotShipState,
	type AutopilotStartOptions,
	type AutopilotStatus,
	type AutopilotStopRequest,
	DEFAULT_AUTOPILOT_SETTINGS,
	DEFAULT_SHIP_POLICY,
	NO_LIMITS,
	type ShipQueueItem,
	shipPolicyForPreset,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	branchProblem,
	branchSlug,
	parseChoice,
	runIdFor,
	suggestBranchName,
	viaWorkBranch,
	worktreeModeFor,
} from "../shared/autopilot-branch";
import { autopilotLogTitle, formatAutopilotLog } from "../shared/autopilot-log";
import type { IpcSpawnTabPayload, IpcSpawnTabResult } from "../shared/ipc-types";
import { QUOTA_FALLBACK_MS, quotaResetAt } from "../shared/quota-reset";
import type {
	ExtensionUIResponse,
	RpcCommand,
	RpcResponse,
	RpcWorktreeCreateResult,
	UsageReport,
} from "../shared/rpc-types";
import { type ApproverRun, AutopilotApprover } from "./autopilot-approver";
import { type AuditScope, type AuditSnapshot, type AuditViolation, auditCycle, takeSnapshot } from "./autopilot-audit";
import { readBranchEntries, readBranchInfo } from "./autopilot-branches";
import { type ShipResult, ShipRunner, type ShipTarget } from "./autopilot-ship";
import type { MainTextKey } from "./i18n-text";
import { ghText, gitRaw, resolveBin } from "./local/git/exec";
import { prCreate } from "./local/git/pr";
import type { WorktreeBranchSource } from "./local/git/worktree";
import { detectReleaseProcedure } from "./release-detect";
import type { TabActivity } from "./sidecar-pool";
import type { SidecarLike } from "./sidecar-types";
import type { GoalSettlement, RelaunchContinuation } from "./turn-resume";
import { recordTurnStop } from "./turn-stop-log";
import type { ClientWindow } from "./web/client-window";

const READY_TIMEOUT_MS = 120_000;
const RELEASE_POLL_MS = 15_000;
const RELEASE_CACHE_MS = 60_000;
const GIT_MS = 30_000;
const WORKTREE_MS = 960_000;
/** Start's guide is at most one model request (the bridge gives it 20 s, plus reading the repo and gh): longer than the default 8 s RPC wait. */
const GUIDE_MS = 45_000;
/** TurnResume arms its scheduled retry a beat after a failed turn is reported; a failure still standing after this is final. */
const ERROR_GRACE_MS = 3_000;
/** A usage-limit stop (the renderer's `messages.ts` "rateLimit" kind): the renderer books the reservation that resumes it. */
const QUOTA_ERROR = /\b429\b|rate[ _-]?limit|too many requests|quota|usage limit|insufficient_quota/i;

function afterMs(run: () => void, ms: number): () => void {
	const timer = setTimeout(run, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
}

/** The message a "Release" button press sends as the user's own words (the bridge's `ship` checks a real user message). */
export const RELEASE_NOW_MESSAGE =
	"Release now: finish the item in progress, start nothing new, then run this repository's release procedure.";

/** What the coordinator needs of the sidecar pool (the real one satisfies it). */
export interface AutopilotPool {
	sidecarOf(tabId: string): SidecarLike | null;
	tabFacts(tabId: string): {
		busy: boolean;
		awaitingConnection?: boolean;
		retrying?: boolean;
		scheduledRetry?: boolean;
	} | null;
	releaseTabWhenExited(tabId: string): Promise<void>;
	noteStopped(tabId: string): void;
	/** Main renamed the tab's live session: the windows learn the name (stock sends no update for an RPC rename). */
	noteSessionName(tabId: string, title: string): void;
	routeSideChannel(id: string, frame: object, tabId?: string): Promise<boolean>;
}

/** DeskTools' side (`AgentControl`): who a tab opened, and emptying a child's queue without aborting it. */
export interface AutopilotControl {
	childrenOf(callerTabId: string): string[];
	clearQueue(tabId: string): Promise<void>;
}

export interface AutopilotNotice {
	kind: "completion" | "error";
	title: string;
	body: string;
}

export interface AutopilotDeps {
	pool: AutopilotPool;
	/** The renderer's own RPC dispatcher (local handlers, quota): `worktree_create` goes through it. */
	dispatch(
		win: ClientWindow,
		sidecar: SidecarLike,
		tabId: string,
		command: RpcCommand,
		timeoutMs?: number,
	): Promise<RpcResponse>;
	spawnTab(win: ClientWindow, payload: IpcSpawnTabPayload): Promise<IpcSpawnTabResult | null>;
	prefs: { get(key: string): unknown };
	/** An OS notification about a tab (batched by notification-batch.ts); the coordinator applies the user's mode. */
	notify(tabId: string, notice: AutopilotNotice): void;
	text(key: MainTextKey, params?: Record<string, string | number>): string;
	/** A run ended (not paused): what it spent stops counting for whoever it is charged to (a paired device). */
	runEnded?(root: string): void;
	/** `gh run view <url> --json status,conclusion`; null when it cannot be read. Default: the installed gh. */
	ghRun?(cwd: string, url: string): Promise<{ status: string; conclusion: string | null } | null>;
	/** Default: the PR Center's own `prCreate` (gh). */
	prCreate?(
		cwd: string,
		input: { title: string; body: string; base?: string; head?: string; draft?: boolean },
	): Promise<{ url: string; number: number }>;
	/**
	 * How a tab whose omp came up with the run `running` goes on (TurnResume's `relaunchContinuation`): after its
	 * launch continuation (`resumeGoal` or `resumeSettled` follows), at once, or not (Continue interrupted work is off).
	 */
	relaunchContinuation(tabId: string): RelaunchContinuation;
	/** Test seams; defaults are the clock, the local date, a timer and the repository's rules files. */
	now?: () => number;
	today?: () => string;
	setTimer?: (run: () => void, ms: number) => () => void;
	/** One-shot timer (default `setTimeout`); returns its cancel. */
	after?: (run: () => void, ms: number) => () => void;
	detectRelease?: (root: string) => Promise<AutopilotReleaseProcedure | null>;
	/** Default: {@link probeRepo}. */
	probeRepo?: (root: string) => Promise<RepoProbe>;
	log?: (message: string) => void;
	/**
	 * The run's summary, written when it ends or pauses (gui-runtime.jsonl, source `autopilot`): it outlives the run's
	 * session, which a person may delete.
	 */
	runLog?: (message: string, details: Record<string, string | number | boolean>) => void;
}

/**
 * What git says of a run's worktree: `present`, `gone` (the folder is missing, or git answers it is no repository) or
 * `unknown` (git did not answer: a timeout, a lock, a spawn failure, any other error).
 */
export type RepoProbe = "present" | "gone" | "unknown";

/** How long a probe that said `gone` waits before it is asked again. */
const REPO_RECHECK_MS = 1_500;

export async function probeRepo(root: string): Promise<RepoProbe> {
	// Only "no such file or folder" is absence; a refused, busy or out-of-handles check says nothing.
	const missing = await access(root).then(
		() => false,
		(error: NodeJS.ErrnoException) => (error.code === "ENOENT" || error.code === "ENOTDIR" ? true : null),
	);
	if (missing === null) return "unknown";
	if (missing) return "gone";
	const result = await gitRaw(root, ["rev-parse", "--git-dir"], { timeoutMs: GIT_MS }).catch(() => null);
	if (result?.code === 0) return "present";
	return result && /not a git repository/i.test(result.stderr) ? "gone" : "unknown";
}

/** A command failure whose message is readable as it is (shown in a toast). */
export class AutopilotError extends Error {
	constructor(
		message: string,
		readonly code = "autopilot_failed",
	) {
		super(message);
		this.name = "AutopilotError";
	}
}

interface ChildState {
	tabId: string;
	branch?: string;
	worktree?: string;
	area?: string;
}

interface Run {
	tabId: string;
	win: ClientWindow | null;
	run: string;
	root: string;
	branch: string;
	baseBranch: string;
	/** The user's default checkout of the repository (where a merge lands). */
	checkoutRoot: string;
	/** Where Push pushes (`HEAD:<target>`) when the run works on a branch of its own off a target another worktree holds. */
	target?: string;
	settings: AutopilotSettings;
	status: AutopilotStatus | null;
	ship: ShipRunner;
	snapshot: AuditSnapshot | null;
	/** Ref moves the ShipRunner journaled since the snapshot, for the audit. */
	expectedRefs: string[];
	checkoutMayMove: boolean;
	configMayChange: boolean;
	/** A verified user request to release was seen: the audit's release scope is open for this cycle. */
	releaseRequested: boolean;
	releaseProcedure?: AutopilotReleaseProcedure;
	releaseBlocked?: string;
	/** The project's default branch green cycles land on (Automatic shipping). */
	landTo?: string;
	/** Landing fell back to a pull request (a protected default branch): told once, shown in the status. */
	landing?: { via: "pr"; url?: string; reason: string };
	/** Cycles whose commit the default branch got this launch (the end summary also asks git). */
	landedCount: number;
	children: Map<string, ChildState>;
	childBranches: Set<string>;
	stopping: boolean;
	/** The earliest time the next nudge may go out. */
	nextNudgeAt: number;
	/** A nudge that came inside the window is asked again when the window passes (one at a time). */
	nudgeLater: boolean;
	/** Cancels the wake armed for the end of a quota wait (`waiting_quota`). */
	cancelQuotaWake: (() => void) | null;
	/** The cycle-end pipeline of one run is sequential. */
	chain: Promise<unknown>;
	refreshing: boolean;
	/** The title this run gave its session (`runSessionTitle`), and whether it already names the first cycle's item. */
	title?: { name: string; item: boolean };
	refreshAgain: boolean;
	stopPolling: (() => void) | null;
	releaseItem?: string;
	/** `#start` is still arming this new run: its first readiness is no restart. */
	starting: boolean;
}

interface ChildRun {
	parentTab: string;
	root: string;
	branch: string;
	area?: string;
}

const REASON_TEXT: Partial<Record<AutopilotPauseReason | AutopilotEndReason, MainTextKey>> = {
	ban_violation: "autopilot.reason.ban_violation",
	repo_gone: "autopilot.reason.repo_gone",
	budget: "autopilot.reason.budget",
	time: "autopilot.reason.time",
	cycles: "autopilot.reason.cycles",
	cost: "autopilot.reason.cost",
	app_closed: "autopilot.reason.app_closed",
	agent_done: "autopilot.reason.agent_done",
	user: "autopilot.reason.user",
	user_pause: "autopilot.reason.user_pause",
	user_abort: "autopilot.reason.user_abort",
	tab_closed: "autopilot.reason.tab_closed",
};

/** What a nudge asks the quiet run for. */
const NUDGE_MESSAGE = "Autopilot: no cycle is running. Call `autopilot begin` and continue with the next cycle.";
/** The least time between two nudges of a run, and after a failed model turn. */
const NUDGE_MS = 20_000;
const ERROR_NUDGE_MS = 60_000;

/** Pauses that are the user's own doing, or a state the screen already shows: no notification. */
const SILENT_REASONS: ReadonlySet<string> = new Set(["user_pause", "user_abort", "app_closed", "tab_closed"]);
/** Pauses that are an outcome the user asked for (a ceiling they set) rather than a failure. */
const COMPLETION_REASONS: ReadonlySet<string> = new Set(["budget", "time", "cycles", "cost", "agent_done", "user"]);

/** `YYYY-MM-DD` in local time: the run id and the branch suffix. */
export function localDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const TITLE_ITEM_MAX = 40;

/**
 * The run's session title, `<prefix> · <what>`: the repository's folder name from the moment the run starts, then its
 * first cycle's picked item. Stock's auto title names a session from the user's first message, and a run has none, so
 * without this the run's row read "Untitled".
 */
export function runSessionTitle(prefix: string, what: string): string {
	const text = what.replace(/\s+/g, " ").trim();
	return `${prefix} · ${text.length > TITLE_ITEM_MAX ? `${text.slice(0, TITLE_ITEM_MAX - 1).trimEnd()}…` : text}`;
}

/**
 * The settings of a start: defaults, then what the start sent. Nothing is stored between runs: shipping nobody chose is
 * decided per repository at the start (`#start`), notifications are the stops a person must know of.
 */
export function startSettings(options: AutopilotStartOptions): AutopilotSettings {
	const remote = options.ship?.remote ?? DEFAULT_SHIP_POLICY.remote;
	const preset: AutopilotShipPolicy = options.preset
		? shipPolicyForPreset(options.preset, remote)
		: DEFAULT_SHIP_POLICY;
	const ship: AutopilotShipPolicy = {
		autoPush: options.ship?.autoPush ?? preset.autoPush,
		autoRelease: options.ship?.autoRelease ?? preset.autoRelease,
		remote,
	};
	const asked = options.maxParallel;
	const maxParallel =
		typeof asked === "number" && Number.isFinite(asked)
			? Math.max(0, Math.floor(asked))
			: DEFAULT_AUTOPILOT_SETTINGS.maxParallel;
	return {
		focus: options.focus ?? [],
		ship,
		limits: { ...NO_LIMITS, ...options.limits },
		maxParallel,
	};
}

/** `gh run view <url> --json status,conclusion` of the installed gh; null when gh is missing or answers oddly. */
export async function ghRunStatus(
	cwd: string,
	url: string,
): Promise<{ status: string; conclusion: string | null } | null> {
	const gh = await resolveBin("gh");
	if (!gh) return null;
	const result = await ghText(cwd, gh, ["run", "view", url, "--json", "status,conclusion"]).catch(() => null);
	if (result?.code !== 0) return null;
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		if (typeof parsed !== "object" || parsed === null) return null;
		const { status, conclusion } = parsed as { status?: unknown; conclusion?: unknown };
		if (typeof status !== "string") return null;
		return { status, conclusion: typeof conclusion === "string" && conclusion ? conclusion : null };
	} catch {
		return null;
	}
}

/** The two commands the coordinator answers (`ipc.ts` routes them here). */
export type AutopilotCommand = { type: "get_autopilot" } | ({ type: "set_autopilot" } & AutopilotAction);

export class Autopilot {
	readonly #deps: AutopilotDeps;
	readonly #runs = new Map<string, Run>();
	readonly #childRuns = new Map<string, ChildRun>();
	readonly #tabOf = new WeakMap<object, string>();
	readonly #approver: AutopilotApprover;
	readonly #releaseCache = new Map<string, { at: number; value: AutopilotReleaseProcedure | null }>();
	/** Tabs whose restart waits for TurnResume's `resumeGoal`. */
	readonly #awaitingResume = new Set<string>();
	/** Fire-and-forget steps in flight (a restart's check, a re-emit, a release poll), so `idle()` can wait for them. */
	readonly #background = new Set<Promise<unknown>>();
	/** Tabs `resumeGoal` already armed and resumed this launch: `#onReady` must not pause them as closed. */
	readonly #resumedOnLaunch = new Set<string>();
	/** Tabs `#onReady` continued at once: a later TurnResume `resumeGoal` for that readiness has nothing left to do. */
	readonly #continuedOnReady = new Set<string>();
	#control: AutopilotControl | null = null;

	constructor(deps: AutopilotDeps) {
		this.#deps = deps;
		this.#approver = new AutopilotApprover({
			runOf: tabId => this.#approverRun(tabId),
			answer: async (tabId, response: ExtensionUIResponse) => {
				await deps.pool.routeSideChannel(response.id, response, tabId);
			},
			denied: (tabId, reason) => this.#log(`denied a card in ${tabId}: ${reason}`),
		});
	}

	/** DeskTools' `AgentControl`, once `ipc.ts` has built it. */
	attachControl(control: AutopilotControl): void {
		this.#control = control;
	}

	// ----------------------------------------------------------------------------------------
	// Wiring from the pool and the sidecar factory
	// ----------------------------------------------------------------------------------------

	/** A tab's sidecar exists (pool acquire): listen for its approval cards and its readiness. */
	attachSidecar(tabId: string, sidecar: SidecarLike): void {
		if (sidecar.device) return;
		this.#tabOf.set(sidecar, tabId);
		sidecar.on("extensionUi", request => this.#approver.handle(tabId, request));
		sidecar.on("status", (payload: { status: string }) => {
			if (payload.status === "ready") {
				this.#track(this.#onReady(tabId).catch(error => this.#log(`ready: ${String(error)}`)));
			}
		});
	}

	/** The pool released the tab (closed by the user, or by us). */
	tabReleased(tabId: string): void {
		this.#childRuns.delete(tabId);
		this.#awaitingResume.delete(tabId);
		this.#continuedOnReady.delete(tabId);
		const run = this.#runs.get(tabId);
		if (!run) return;
		this.#runs.delete(tabId);
		run.stopPolling?.();
		run.cancelQuotaWake?.();
		for (const child of run.children.keys()) {
			this.#childRuns.delete(child);
			this.#track(this.#deps.pool.releaseTabWhenExited(child).catch(() => undefined));
		}
	}

	/**
	 * The pool's tab activity (`observeTabs`): a released tab ends its run; a failed turn that neither stock's
	 * auto-retry nor TurnResume's scheduled retries will take up (they are spent) gets a nudge for the next cycle, never a
	 * pause. A usage limit waits here (`#waitForQuota`): journaled `waiting_quota` with its reset, woken at it.
	 */
	observeActivity(activity: TabActivity): void {
		if (activity.type === "released") {
			this.tabReleased(activity.tabId);
			return;
		}
		if (activity.type !== "idle" || activity.outcome?.stopReason !== "error") return;
		const run = this.#runs.get(activity.tabId);
		const message = activity.outcome.errorMessage ?? "";
		if (!run) return;
		if (QUOTA_ERROR.test(message)) {
			// Stock's own auto-retry may still take it: look once it has had the chance, as for any other failure.
			(this.#deps.after ?? afterMs)(() => this.#enqueue(run, () => this.#waitForQuota(run)), ERROR_GRACE_MS);
			return;
		}
		// TurnResume arms its retry a moment after the failure is reported: look again once it has had the chance (the
		// nudge itself asks nothing while a retry, a turn or the connection wait holds the run).
		(this.#deps.after ?? afterMs)(() => this.#enqueue(run, () => this.#nudge(run, "error")), ERROR_GRACE_MS);
	}

	/**
	 * The run is still this tab's, running, and nothing else holds its next turn: no turn going, no stock auto-retry, no
	 * retry TurnResume armed, no wait for the connection. `#nudge` asks it right before it prompts.
	 */
	async #quietAndRunning(run: Run): Promise<boolean> {
		if (this.#runs.get(run.tabId) !== run || run.stopping) return false;
		const facts = this.#deps.pool.tabFacts(run.tabId);
		if (!facts || facts.busy || facts.awaitingConnection || facts.retrying || facts.scheduledRetry) return false;
		const status = await this.#fetchStatus(run).catch(() => null);
		return status?.state === "running";
	}

	/** The sidecar factory's `frameTransform` for `autopilot_update`: the status plus what only main knows. */
	overlay(sidecar: object, frame: Record<string, unknown>): Record<string, unknown> {
		const tabId = this.#tabOf.get(sidecar);
		const run = tabId ? this.#runs.get(tabId) : undefined;
		const status = frame.status as AutopilotStatus | undefined;
		if (!run || !status?.active) return frame;
		run.status = status;
		if (status.settings) run.settings = status.settings;
		this.#titleByItem(run, status.now?.n === 1 ? status.now.title : undefined);
		return { ...frame, status: this.#overlaid(run, status) };
	}

	/** The run's title names its first cycle's item once: from `pick` while cycle 1 runs, else from cycle 1's record. */
	#titleByItem(run: Run, item: string | undefined): void {
		if (!item || !run.title || run.title.item) return;
		run.title = { ...run.title, item: true };
		void this.#retitle(run, item);
	}

	/** The bridge's cycle end, stop request and settled frames. */
	frame(sidecar: object, frame: Record<string, unknown>): void {
		const tabId = this.#tabOf.get(sidecar);
		const run = tabId ? this.#runs.get(tabId) : undefined;
		if (!run) return;
		if (frame.type === "autopilot_cycle_end") {
			const record = frame.record as AutopilotCycleRecord;
			const receivedAt = this.#now();
			if (record.n === 1) this.#titleByItem(run, record.title);
			this.#enqueue(run, () => this.#cycleEnd(run, record, receivedAt));
		} else if (frame.type === "autopilot_nudge") {
			const reason = frame.reason as AutopilotNudgeReason;
			this.#enqueue(run, () => this.#nudge(run, reason));
		} else if (frame.type === "autopilot_stop_requested") {
			const request = frame as unknown as AutopilotStopRequest;
			this.#enqueue(run, () => this.#stopRequested(run, request));
		} else if (frame.type === "autopilot_settled") {
			const reason = frame.reason as AutopilotPauseReason | AutopilotEndReason;
			this.#enqueue(run, () => this.#settled(run, reason));
		}
	}

	// ----------------------------------------------------------------------------------------
	// Commands (ipc.ts hands `get_autopilot` and `set_autopilot` here)
	// ----------------------------------------------------------------------------------------

	async handleCommand(
		win: ClientWindow,
		sidecar: SidecarLike,
		tabId: string,
		command: AutopilotCommand,
		id: string | undefined,
	): Promise<RpcResponse> {
		try {
			const data =
				command.type === "get_autopilot"
					? await this.status(sidecar, tabId)
					: await this.#action(win, sidecar, tabId, command);
			return { id, type: "response", command: command.type, success: true, data } as RpcResponse;
		} catch (error) {
			return {
				id,
				type: "response",
				command: command.type,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof AutopilotError ? { code: error.code } : {}),
			} as RpcResponse;
		}
	}

	/** `get_autopilot`: a run's whole status, or for any other tab what the start sheet needs. */
	async status(sidecar: SidecarLike, tabId: string): Promise<AutopilotStatus> {
		const run = this.#runs.get(tabId) ?? (await this.#adopt(tabId));
		if (run) return this.#overlaid(run, await this.#fetchStatus(run));
		const status = await this.#bridge<AutopilotStatus>(tabId, AUTOPILOT_BRIDGE_METHODS.status, {}).catch(() => null);
		if (status?.active) return status;
		return this.#idleStatus(sidecar);
	}

	async #action(
		win: ClientWindow,
		sidecar: SidecarLike,
		tabId: string,
		action: AutopilotAction,
	): Promise<AutopilotStatus & { tabId?: string }> {
		if (action.action === "start") return this.#start(win, sidecar, tabId, action);
		const run = this.#runs.get(tabId) ?? (await this.#adopt(tabId));
		if (!run) throw new AutopilotError(this.#deps.text("autopilot.err.noRun"), "autopilot_no_run");
		switch (action.action) {
			case "stop":
				await this.#beginStop(run, "user");
				break;
			case "abort":
				this.#deps.pool.noteStopped(tabId);
				recordTurnStop({ command: "abort", tab: tabId, by: "autopilot", surface: "stop-now" });
				await this.#stock(tabId, { type: "abort" }).catch(() => undefined);
				await this.aborted(tabId);
				break;
			case "pause":
				await this.#stock(tabId, { type: "set_goal", action: "pause" });
				await this.#setState(run, { state: "paused", reason: "user_pause" });
				break;
			case "resume":
				await this.#resume(run);
				break;
			case "configure": {
				const { action: _action, ...changes } = action;
				await this.#configure(run, changes);
				break;
			}
			case "note":
				await this.#bridge(tabId, AUTOPILOT_BRIDGE_METHODS.note, { text: action.text });
				break;
			case "backlog_add":
				await this.#bridge(tabId, AUTOPILOT_BRIDGE_METHODS.backlog, { op: "add", text: action.text });
				break;
			case "backlog_remove":
				await this.#bridge(tabId, AUTOPILOT_BRIDGE_METHODS.backlog, { op: "remove", id: action.id });
				break;
			case "ship":
				await this.#shipAction(run, action);
				break;
			case "cancel_ship":
				run.ship.cancel(action.id);
				break;
		}
		return this.#overlaid(run, await this.#fetchStatus(run));
	}

	// ----------------------------------------------------------------------------------------
	// Start
	// ----------------------------------------------------------------------------------------

	async #start(
		win: ClientWindow,
		sidecar: SidecarLike,
		tabId: string,
		options: AutopilotStartOptions,
	): Promise<AutopilotStatus & { tabId: string }> {
		const text = this.#deps.text;
		if (sidecar.device) throw new AutopilotError(text("autopilot.err.device"), "autopilot_device");
		const existing = this.#runs.get(tabId) ?? (await this.#adopt(tabId));
		if (existing) throw new AutopilotError(text("autopilot.err.running"), "autopilot_running");
		const cwd = sidecar.cwd;
		const toplevel = await this.#gitText(cwd, ["rev-parse", "--show-toplevel"]);
		if (!toplevel || !(await this.#gitText(cwd, ["rev-parse", "--verify", "-q", "HEAD"]))) {
			throw new AutopilotError(text("autopilot.err.notRepo"), "autopilot_not_repo");
		}
		const checkoutBranch = await this.#gitText(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
		if (!checkoutBranch) throw new AutopilotError(text("autopilot.err.detached"), "autopilot_detached");
		const remoteChosen = options.ship?.remote ?? (await this.#detectRemote(cwd));
		const shipUndecided =
			options.preset === undefined &&
			options.ship?.autoPush === undefined &&
			options.ship?.autoRelease === undefined;
		let settings = startSettings({ ...options, ship: { ...options.ship, remote: remoteChosen } });
		const checkoutRelease = await this.#releaseFor(toplevel);
		if ((settings.ship.autoRelease.on || options.preset === "release") && !checkoutRelease.procedure) {
			throw new AutopilotError(text("autopilot.err.noRelease"), "autopilot_no_release");
		}
		// The app owns the guide: the repo's own (an agent's text first), a Release section added from the project's facts
		// when it has none, or a whole one built from them. Built while the worktree is made; committed into it below.
		const guideWork = this.#guideToCommit(tabId, toplevel, checkoutRelease.procedure, options.guide);

		// The branch is checked now, from git's own state: the sheet's list may be old.
		const date = this.#deps.today?.() ?? localDate(new Date());
		const choice: AutopilotBranchChoice | null =
			options.branch === undefined ? { kind: "new" } : parseChoice(options.branch);
		if (!choice) {
			throw new AutopilotError(text("autopilot.err.branchInvalid", { branch: "" }), "autopilot_branch_invalid");
		}
		const { entries, defaultBranch } = await readBranchEntries(cwd, settings.ship.remote);
		this.#refuseBranch(choice, entries);
		const target = viaWorkBranch(choice, entries);
		// Nobody chose a level: land every green cycle with a commit on the project's default branch (ShipRunner's
		// fast-forward push, never the agent's, never forced; a protected branch gets one pull request instead) when the
		// repository has a remote. Without a known default branch the run's own branch is pushed; without a remote, nothing.
		// Releasing is decided below, from the procedure.
		const hasRemote = shipUndecided && (await this.#gitText(cwd, ["remote"])).trim() !== "";
		if (shipUndecided) {
			const land = hasRemote && defaultBranch !== null;
			settings = {
				...settings,
				ship: { ...settings.ship, autoPush: hasRemote && !land, ...(land ? { land: true } : {}) },
			};
		}
		const mode = worktreeModeFor(choice, entries);
		const taken = new Set(entries.map(entry => entry.name));
		// A target another worktree holds (main in the user's folder): work on a branch of our own cut from it.
		const source: WorktreeBranchSource | null = target
			? {
					name: suggestBranchName(date, taken),
					mode: "new",
					from: entries.find(entry => entry.name === target)?.local ? target : `${settings.ship.remote}/${target}`,
				}
			: choice.kind === "existing"
				? { name: choice.name, mode, ...(mode === "remote" ? { remote: settings.ship.remote } : {}) }
				: choice.name
					? { name: choice.name, mode }
					: null;
		const created = await this.#deps.dispatch(
			win,
			sidecar,
			tabId,
			{
				type: "worktree_create",
				name: source ? branchSlug(source.name, date) : date,
				baseCwd: cwd,
				baseRef: "HEAD",
				branchPrefix: "autopilot/",
				...(source ? { branch: source } : {}),
			},
			WORKTREE_MS,
		);
		if (!created.success) throw new AutopilotError(created.error ?? "Creating the worktree failed.");
		const made = created.data as RpcWorktreeCreateResult;
		const guide = await guideWork;
		if (guide) await this.#commitGuide(made.path, guide.text);
		// The run's own checkout holds the guide now, so its Release section counts when no rules file names a procedure.
		const release = await this.#releaseFor(made.path);
		// Nobody chose a level and a procedure says the project releases: the agent releases by it, when it judges the
		// changes worth one (cadence `agent`). No remote: nothing to release to.
		if (shipUndecided && hasRemote && release.procedure) {
			settings = {
				...settings,
				ship: { ...settings.ship, autoRelease: { ...settings.ship.autoRelease, on: true } },
			};
		}
		this.#deps.log?.(
			`autopilot: guide ${guide ? `${guide.source}, release ${guide.release}, releases ${guide.releases}` : "unavailable"}; ship ${settings.ship.land ? `land on ${defaultBranch}` : `push ${settings.ship.autoPush}`}, release ${settings.ship.autoRelease.on}${release.procedure ? ` (${release.procedure.file})` : ""}`,
		);
		// The run's own base: the folder's branch, or, on the default branch itself, that branch (a release pushes it).
		const baseBranch = (target ?? made.branch) === defaultBranch ? (target ?? made.branch) : checkoutBranch;
		const runId = runIdFor(made.branch, date);
		const spawned = await this.#deps.spawnTab(win, {
			cwd: made.path,
			worktree: { name: runId, branch: made.branch, baseCwd: made.baseCwd, path: made.path },
		});
		if (!spawned?.tabId) throw new AutopilotError("The Autopilot tab could not be opened.");
		const newTab = spawned.tabId;
		const run = this.#newRun(newTab, win, {
			run: runId,
			root: made.path,
			branch: made.branch,
			baseBranch,
			...(target ? { target } : {}),
			...(settings.ship.land ? { landTo: defaultBranch } : {}),
			checkoutRoot: made.baseCwd,
			settings,
			release,
		});
		run.starting = true;
		try {
			await this.#ready(newTab);
			await this.#retitle(run, basename(toplevel));
			const arm: AutopilotArmParams = {
				role: "parent",
				root: made.path,
				run: runId,
				branch: made.branch,
				baseBranch,
				...(target ? { target } : {}),
				settings,
				...(release.procedure ? { releaseProcedure: release.procedure } : {}),
				...(release.blocked ? { releaseBlocked: release.blocked } : {}),
			};
			run.status = await this.#bridge<AutopilotStatus>(newTab, AUTOPILOT_BRIDGE_METHODS.arm, arm);
			for (const text of options.backlog ?? []) {
				run.status = await this.#bridge<AutopilotStatus>(newTab, AUTOPILOT_BRIDGE_METHODS.backlog, {
					op: "add",
					text,
				});
			}
			run.snapshot = await takeSnapshot(made.path, made.baseCwd).catch(() => null);
			const tokenBudget = settings.limits.tokens;
			const goalResponse = await this.#stockResponse(newTab, {
				type: "set_goal",
				objective: AUTOPILOT_OBJECTIVE,
				...(tokenBudget ? { tokenBudget } : {}),
			});
			if (!goalResponse.success) throw new Error(goalResponse.error ?? "The goal could not be created.");
		} catch (error) {
			// The tab stays (its worktree has nothing in it yet); the run does not.
			await this.#bridge(newTab, AUTOPILOT_BRIDGE_METHODS.disarm, {}).catch(() => undefined);
			this.#runs.delete(newTab);
			throw error instanceof AutopilotError
				? error
				: new AutopilotError(error instanceof Error ? error.message : String(error));
		} finally {
			run.starting = false;
		}
		return { ...this.#overlaid(run, await this.#fetchStatus(run)), tabId: newTab };
	}

	#newRun(
		tabId: string,
		win: ClientWindow | null,
		info: {
			run: string;
			root: string;
			branch: string;
			baseBranch: string;
			checkoutRoot: string;
			target?: string;
			landTo?: string | null;
			settings: AutopilotSettings;
			release: { procedure: AutopilotReleaseProcedure | null; blocked?: string };
		},
	): Run {
		const run: Run = {
			tabId,
			win,
			run: info.run,
			root: info.root,
			branch: info.branch,
			baseBranch: info.baseBranch,
			...(info.target ? { target: info.target } : {}),
			...(info.landTo ? { landTo: info.landTo } : {}),
			landedCount: 0,
			checkoutRoot: info.checkoutRoot,
			settings: info.settings,
			status: null,
			ship: new ShipRunner({
				journal: async action => {
					run.expectedRefs.push(...action.refs);
					if (action.kind === "merge") run.checkoutMayMove = true;
					if (action.kind === "push") run.configMayChange = true;
					await this.#bridge(tabId, AUTOPILOT_BRIDGE_METHODS.shipAction, action);
				},
				changed: () => this.#track(this.#refresh(run)),
				reverted: async cycle => {
					await this.#bridge(tabId, AUTOPILOT_BRIDGE_METHODS.markReverted, { cycle });
				},
				prText: async () => {
					const cycles = run.status?.cycles ?? [];
					return {
						title: autopilotLogTitle(run.branch, cycles.length),
						body: formatAutopilotLog({ branch: run.branch, cycles }),
					};
				},
				prCreate: (cwd, input) => (this.#deps.prCreate ?? prCreate)(cwd, input),
				now: () => this.#now(),
				id: () => `ship-${randomUUID().slice(0, 8)}`,
			}),
			snapshot: null,
			expectedRefs: [],
			checkoutMayMove: false,
			configMayChange: false,
			releaseRequested: false,
			...(info.release.procedure ? { releaseProcedure: info.release.procedure } : {}),
			...(info.release.blocked ? { releaseBlocked: info.release.blocked } : {}),
			children: new Map(),
			childBranches: new Set(),
			stopping: false,
			starting: false,
			nextNudgeAt: 0,
			nudgeLater: false,
			cancelQuotaWake: null,
			chain: Promise.resolve(),
			refreshing: false,
			refreshAgain: false,
			stopPolling: null,
		};
		this.#runs.set(tabId, run);
		return run;
	}

	/** A run the journal knows but this process does not (relaunch, a tab opened from the sidebar). */
	async #adopt(tabId: string): Promise<Run | null> {
		const existing = this.#runs.get(tabId);
		if (existing) return existing;
		const sidecar = this.#deps.pool.sidecarOf(tabId);
		if (!sidecar || sidecar.device || sidecar.status !== "ready" || this.#childRuns.has(tabId)) return null;
		const status = await this.#bridge<AutopilotStatus>(tabId, AUTOPILOT_BRIDGE_METHODS.status, {}).catch(() => null);
		if (!status?.active || status.role === "child" || !status.root || !status.branch || !status.settings) return null;
		if (status.state === "ended") return null;
		const raced = this.#runs.get(tabId);
		if (raced) return raced;
		const checkoutRoot = (await this.#commonCheckout(status.root)) ?? status.root;
		const release = await this.#releaseFor(status.root);
		const run = this.#newRun(tabId, null, {
			run: status.run ?? status.branch,
			root: status.root,
			branch: status.branch,
			...(status.target ? { target: status.target } : {}),
			landTo: status.settings.ship.land
				? (await readBranchEntries(status.root, status.settings.ship.remote).catch(() => null))?.defaultBranch
				: null,
			baseBranch: status.baseBranch ?? "main",
			checkoutRoot,
			settings: status.settings,
			release,
		});
		run.status = status;
		run.snapshot = await takeSnapshot(status.root, checkoutRoot).catch(() => null);
		if (status.ship?.release?.state === "pending" && status.ship.release.runUrl) {
			this.#pollRelease(run, status.ship.release.version, status.ship.release.runUrl);
		}
		return run;
	}

	// ----------------------------------------------------------------------------------------
	// Stop, abort, resume
	// ----------------------------------------------------------------------------------------

	/** ■ (`STOP_COMMANDS` in ipc.ts): the running children stop with the parent; the run shows paused. */
	async aborted(tabId: string): Promise<void> {
		const run = this.#runs.get(tabId);
		if (!run) return;
		await Promise.all(
			[...run.children.keys()].map(async child => {
				if (!this.#deps.pool.tabFacts(child)?.busy) return;
				this.#deps.pool.noteStopped(child);
				recordTurnStop({ command: "abort", tab: child, by: "autopilot", surface: "run-stopped", caller: tabId });
				await this.#stock(child, { type: "abort" }).catch(() => undefined);
			}),
		);
		if (run.stopping) return;
		await this.#setState(run, { state: "paused", reason: "user_abort" }).catch(error =>
			this.#log(`abort state: ${String(error)}`),
		);
	}

	/** "Stop" (the user ends the run) or an end the bridge asked for: finish the turn, then wind down. */
	async #beginStop(run: Run, reason: AutopilotEndReason): Promise<void> {
		if (run.stopping) return;
		run.stopping = true;
		await this.#stock(run.tabId, { type: "set_goal", action: "pause" }).catch(() => undefined);
		await this.#setState(run, { state: "stopping", reason });
		const control = this.#control;
		if (control) {
			await Promise.all([...run.children.keys()].map(child => control.clearQueue(child).catch(() => undefined)));
		}
		// No turn in flight: no `agent_end` will bring `autopilot_settled`.
		if (!this.#deps.pool.tabFacts(run.tabId)?.busy) this.#enqueue(run, () => this.#settled(run, reason));
	}

	/** DeskTools: a stopping run opens and sends nothing new. */
	isStopping(callerTabId: string): boolean {
		return this.#runs.get(callerTabId)?.stopping === true;
	}

	/** The worktree of the run `tabId` is, or whose child it is; undefined for any other tab. */
	runRootOf(tabId: string): string | undefined {
		const parent = this.#childRuns.get(tabId)?.parentTab ?? tabId;
		return this.#runs.get(parent)?.root;
	}
	async #resume(run: Run): Promise<void> {
		run.stopping = false;
		run.cancelQuotaWake?.();
		run.cancelQuotaWake = null;
		const status = await this.#fetchStatus(run);
		await this.#arm(run, status, true);
		const response = await this.#stockResponse(run.tabId, { type: "set_goal", action: "resume" });
		if (!response.success) throw new AutopilotError(response.error ?? "The goal could not be resumed.");
	}

	async #arm(run: Run, status: AutopilotStatus, resume: boolean): Promise<void> {
		const settings = status.settings ?? run.settings;
		const procedure = await this.#releaseFor(run.root);
		const arm: AutopilotArmParams = {
			role: "parent",
			root: run.root,
			run: run.run,
			branch: run.branch,
			baseBranch: run.baseBranch,
			...(run.target ? { target: run.target } : {}),
			settings,
			resume,
			...(procedure.procedure ? { releaseProcedure: procedure.procedure } : {}),
			...(procedure.blocked ? { releaseBlocked: procedure.blocked } : {}),
		};
		run.status = await this.#bridge<AutopilotStatus>(run.tabId, AUTOPILOT_BRIDGE_METHODS.arm, arm);
		run.snapshot = await takeSnapshot(run.root, run.checkoutRoot).catch(() => run.snapshot);
	}

	/**
	 * TurnResume's goal resume after a relaunch (`ResumeDeps.resumeGoal`): an autopilot run is armed again first
	 * (overrides, tools and guard before the goal), any other tab gets stock's own resume.
	 */
	async resumeGoal(tabId: string): Promise<void> {
		// TurnResume's restore/retry chain is shorter than `#onReady`'s adoption: adopt here, not through `#awaitingResume`.
		const run = this.#runs.get(tabId) ?? (await this.#adopt(tabId));
		const status = run ? await this.#fetchStatus(run).catch(() => null) : null;
		if (run && status?.state === "running") {
			// `#onReady` already continued this readiness (TurnResume's marker was not in place yet when it judged).
			if (this.#continuedOnReady.delete(tabId)) return;
			// `#onReady` has not judged this readiness yet when it is not waiting on us: it must not resume it again.
			if (!this.#awaitingResume.delete(tabId)) this.#resumedOnLaunch.add(tabId);
			try {
				await this.#continueAfterRestart(run);
			} catch (error) {
				// Shown paused with Resume; TurnResume drops the marker, so the next launch does not resume it unarmed.
				await this.#closedQuietly(run);
				throw error;
			}
			return;
		}
		// A resume without an arm leaves the run on the startup tool set: say why, so a missing arm explains itself.
		this.#log(
			`resumeGoal ${tabId}: plain stock resume (run ${run ? "adopted" : "none"}, state ${status?.state ?? "unread"})`,
		);
		const response = await this.#stockResponse(tabId, { type: "set_goal", action: "resume" });
		if (!response.success) throw new Error(response.error ?? "the tab is gone");
	}

	/**
	 * TurnResume finished a tab's launch continuation. A run it did not resume goes on all the same: the journal says
	 * `running`, whatever the restore read from stock's journal of the cut. Only the user's Stop on the "Continuing"
	 * toast leaves it paused.
	 */
	resumeSettled(tabId: string, outcome: GoalSettlement): void {
		if (outcome === "resumed" || !this.#awaitingResume.delete(tabId)) return;
		const run = this.#runs.get(tabId);
		if (!run) return;
		this.#track(outcome === "cancelled" ? this.#closedQuietly(run) : this.#continueOrPause(run));
	}

	async #onReady(tabId: string): Promise<void> {
		if (this.#childRuns.has(tabId)) return;
		const run = await this.#adopt(tabId);
		if (!run || run.starting || this.#resumedOnLaunch.delete(tabId)) return;
		const status = await this.#fetchStatus(run);
		if (status.state === "waiting_quota") {
			// A wait the last process journaled: stock paused the goal at startup, so the wake resumes it like a restart.
			this.#armQuotaWake(run, status.quotaResetAt ?? this.#now(), true);
			return;
		}
		if (status.state !== "running" || this.#resumedOnLaunch.delete(tabId)) return;
		// The process came up with the run `running` in its journal (a relaunch, or its omp restarted): stock paused
		// the goal at startup. The run goes on after any restart; with a launch marker, after TurnResume's restore.
		const continuation = this.#deps.relaunchContinuation(tabId);
		if (continuation === "after_restore") this.#awaitingResume.add(tabId);
		else if (continuation === "now") {
			this.#continuedOnReady.add(tabId);
			await this.#continueOrPause(run);
		} else await this.#appClosed(run);
	}

	/** The run goes on after a restart; if stock cannot resume its goal, it shows paused with Resume. */
	async #continueOrPause(run: Run): Promise<void> {
		try {
			await this.#continueAfterRestart(run);
		} catch (error) {
			this.#log(`resume after restart: ${String(error)}`);
			await this.#closedQuietly(run);
		}
	}

	/**
	 * Arm and resume a run whose omp came up again. Stock reattached the goal paused at startup and remembered the
	 * tool set of that moment (ask, eval, debug and no `autopilot`); its `goal resume` would put that set back over
	 * the armed one. Its `goal pause` drops what it remembered (stock restores it and forgets it), so the arm comes
	 * after the pause and the resume keeps the armed set, as it does for a run the user resumes.
	 */
	async #continueAfterRestart(run: Run): Promise<void> {
		const paused = await this.#stockResponse(run.tabId, { type: "set_goal", action: "pause" });
		if (!paused.success) throw new AutopilotError(paused.error ?? "The goal could not be paused.");
		await this.#resume(run);
	}

	async #closedQuietly(run: Run): Promise<void> {
		await this.#appClosed(run).catch(error => this.#log(`app_closed: ${String(error)}`));
	}

	async #appClosed(run: Run): Promise<void> {
		await this.#stock(run.tabId, { type: "set_goal", action: "pause" }).catch(() => undefined);
		await this.#setState(run, { state: "paused", reason: "app_closed" });
	}

	// ----------------------------------------------------------------------------------------
	// Configure and ship actions
	// ----------------------------------------------------------------------------------------

	async #configure(
		run: Run,
		changes: {
			focus?: AutopilotArea[];
			ship?: Partial<AutopilotShipPolicy>;
			limits?: Partial<AutopilotSettings["limits"]>;
		},
	): Promise<void> {
		if (changes.ship?.autoRelease?.on === true && !(await this.#releaseFor(run.root)).procedure) {
			throw new AutopilotError(this.#deps.text("autopilot.err.noRelease"), "autopilot_no_release");
		}
		const status = await this.#bridge<AutopilotStatus>(run.tabId, AUTOPILOT_BRIDGE_METHODS.configure, changes);
		if (status.settings) run.settings = status.settings;
	}

	async #shipAction(run: Run, action: Extract<AutopilotAction, { action: "ship" }>): Promise<void> {
		const kind = action.kind;
		if (kind === "auto_push" || kind === "auto_release") {
			const enabled = action.enabled === true;
			const current = run.settings.ship;
			await this.#configure(
				run,
				kind === "auto_push"
					? { ship: { autoPush: enabled } }
					: { ship: { autoRelease: { ...current.autoRelease, on: enabled } } },
			);
			return;
		}
		if (kind === "release") {
			const procedure = (await this.#releaseFor(run.root)).procedure;
			if (!procedure) throw new AutopilotError(this.#deps.text("autopilot.err.noRelease"), "autopilot_no_release");
			run.releaseItem = run.ship.track({ kind: "release", detail: "requested" }).id;
			await this.#stockResponse(run.tabId, {
				type: "prompt",
				message: RELEASE_NOW_MESSAGE,
				streamingBehavior: "followUp",
			});
			return;
		}
		// Merge lands the run's own branch on the base; a PR is opened from the branch Push moves (the target, when there is one).
		const nothingToShip =
			kind === "merge"
				? run.branch === run.baseBranch
				: kind === "pr" && (run.target ?? run.branch) === run.baseBranch;
		if (nothingToShip) throw new AutopilotError(this.#deps.text("autopilot.err.onBase"), "autopilot_on_base");
		if (kind === "revert") {
			const cycle = (run.status?.cycles ?? []).find(entry => entry.n === action.cycle);
			if (!cycle?.commit) throw new AutopilotError(this.#deps.text("autopilot.err.noCommit"), "autopilot_no_commit");
			run.ship.enqueue({ kind: "revert", cycle: cycle.n, sha: cycle.commit });
		} else {
			run.ship.enqueue({ kind, ...(action.mode ? { mode: action.mode } : {}) });
		}
		// Between turns it runs now; inside one, at that turn's end (`#cycleEnd`). The pool's busy flag can lag a turn's
		// start, so a cycle the journal shows in flight (`begin` called, no record yet) holds the queue too.
		const status = await this.#fetchStatus(run).catch(() => null);
		const cycleInFlight = status?.now !== undefined && (status.state === "running" || status.state === "stopping");
		if (!this.#deps.pool.tabFacts(run.tabId)?.busy && !cycleInFlight) this.#enqueue(run, () => this.#drain(run));
	}

	// ----------------------------------------------------------------------------------------
	// A cycle's end: children, audit, ship
	// ----------------------------------------------------------------------------------------

	#enqueue(run: Run, work: () => Promise<void>): void {
		run.chain = run.chain.then(work).catch(error => this.#log(`${run.tabId}: ${String(error)}`));
	}

	async #cycleEnd(run: Run, record: AutopilotCycleRecord, receivedAt: number): Promise<void> {
		// The repository vanishing is one of the few stops left: nothing can be committed or audited without it. Only a
		// confirmed loss pauses; a git that cannot answer this time (a lock, a timeout, a load spike) skips this cycle's
		// audit and shipping, and the next cycle end checks again against the same snapshot.
		const repo = await this.#repoState(run.root);
		if (repo === "gone") {
			await this.#pause(run, "repo_gone", run.root);
			return;
		}
		if (repo === "unknown") {
			this.#log(
				`${run.tabId}: git did not answer at cycle ${record.n}'s end; its audit and shipping wait for the next`,
			);
			return;
		}
		await this.#closeChildren(run, record.n);
		let requests: Array<{ kind: "push" | "release" }> = [];
		try {
			requests = (
				await this.#bridge<{ requests: Array<{ kind: "push" | "release" }> }>(
					run.tabId,
					AUTOPILOT_BRIDGE_METHODS.takeShipRequests,
					{},
				)
			).requests;
		} catch (error) {
			this.#log(`ship requests: ${String(error)}`);
		}
		if (requests.some(request => request.kind === "release")) run.releaseRequested = true;
		const violations = await this.#audit(run);
		if (violations.length > 0) {
			await this.#violation(run, violations);
			return;
		}
		run.releaseRequested = false;
		if (record.ship) await this.#releaseReported(run, record.ship);
		const wantsPush = requests.some(request => request.kind === "push");
		const green = record.verify === "green";
		const autoPush = run.settings.ship.autoPush && green;
		const queued = (kind: "push" | "land") =>
			run.ship.queue().some(item => item.kind === kind && item.state === "queued");
		const own = new Set<string>();
		if ((wantsPush || autoPush) && !queued("push")) {
			// Pinned to the cycle's own commit: this push may run after a later turn has moved HEAD.
			own.add(run.ship.enqueue({ kind: "push", ...(record.commit ? { sha: record.commit } : {}) }).id);
		}
		// Automatic shipping: only a green cycle with a commit of its own lands; a red one or one without a commit never.
		// Its check command goes along: a default branch that moved on is merged and that merge checked before it lands.
		if (run.settings.ship.land && green && record.commit && !queued("land")) {
			own.add(
				run.ship.enqueue({
					kind: "land",
					sha: record.commit,
					...(record.checkCommand ? { check: record.checkCommand } : {}),
				}).id,
			);
		}
		// This pipeline can outlive the next cycle's start: what the user queued after the frame arrived waits for that
		// turn's end; everything queued before it, and this cycle's own push and land, go now.
		await this.#drain(run, item => own.has(item.id) || item.at <= receivedAt);
	}

	async #audit(run: Run): Promise<AuditViolation[]> {
		if (!run.snapshot) {
			run.snapshot = await takeSnapshot(run.root, run.checkoutRoot).catch(() => null);
			return [];
		}
		const after = await takeSnapshot(run.root, run.checkoutRoot).catch(() => null);
		if (!after) return [];
		const scope: AuditScope = {
			branch: run.branch,
			childBranches: [...run.childBranches],
			remote: run.settings.ship.remote,
			defaultBranch: run.baseBranch,
			release:
				run.settings.ship.autoRelease.on || run.releaseRequested || run.status?.ship?.inFlight?.kind === "release",
			expectedRefs: run.expectedRefs,
			checkoutMayMove: run.checkoutMayMove,
			configMayChange: run.configMayChange,
		};
		const violations = await auditCycle(run.root, run.snapshot, after, scope);
		run.snapshot = after;
		run.expectedRefs = [];
		run.checkoutMayMove = false;
		run.configMayChange = false;
		return violations;
	}

	async #violation(run: Run, violations: AuditViolation[]): Promise<void> {
		const detail = violations.map(violation => violation.detail).join("; ");
		this.#log(`ban violation in ${run.tabId}: ${detail}`);
		await this.#pause(run, "ban_violation", detail);
	}

	/** Run the ShipRunner's queue; a refused or repeatedly unreachable push stops the run. */
	async #drain(run: Run, accept?: (item: ShipQueueItem) => boolean): Promise<void> {
		const waiting = run.ship.queue().filter(item => item.state === "queued" && (accept?.(item) ?? true));
		if (waiting.length === 0) return;
		const pushing = waiting.some(item => item.kind === "push" || item.kind === "pr" || item.kind === "land");
		if (pushing) {
			await this.#setState(run, { inFlight: { kind: "push", startedAt: this.#now() } }).catch(() => undefined);
		}
		const target: ShipTarget = {
			root: run.root,
			checkoutRoot: run.checkoutRoot,
			branch: run.branch,
			...(run.target ? { pushTo: run.target } : {}),
			baseBranch: run.baseBranch,
			remote: run.settings.ship.remote,
			...(run.landTo ? { landTo: run.landTo } : {}),
		};
		const results = await run.ship.drain(target, accept);
		if (pushing) await this.#setState(run, { inFlight: null }).catch(() => undefined);
		// What the ShipRunner moved is now part of the baseline.
		run.snapshot = await takeSnapshot(run.root, run.checkoutRoot).catch(() => run.snapshot);
		run.expectedRefs = [];
		run.checkoutMayMove = false;
		run.configMayChange = false;
		for (const result of results) {
			if (result.item.kind === "land") {
				await this.#landed(run, result);
				continue;
			}
			if (result.item.kind !== "push" && result.item.kind !== "pr") continue;
			if (result.item.state === "done") continue;
			// A rejected or unreachable push is reported (the queue item keeps its reason, the agent gets a note) and
			// the next cycle repairs it: merge the remote branch, never force. The run is not paused for it.
			await this.#tellAgent(
				run,
				`The push of ${run.branch} failed: ${result.item.detail ?? "unknown reason"}. Autopilot never forces a push: run git fetch, merge ${run.settings.ship.remote}/${run.branch} into the branch, check again, and the next green cycle pushes it.`,
			);
		}
	}

	/**
	 * What a land did, told where it matters: a default branch that moved (or a merge that would conflict) is a note to
	 * the next cycle, never a stop; the first fallback to a pull request is said once (status line, notification, note).
	 */
	async #landed(run: Run, result: ShipResult): Promise<void> {
		const outcome = result.land;
		const remote = run.settings.ship.remote;
		const dest = run.landTo ?? run.baseBranch;
		if (outcome?.kind === "landed") {
			run.landedCount++;
			const merge = outcome.merge;
			if (merge) {
				this.#log(
					`${run.tabId}: landed ${outcome.sha.slice(0, 9)} on ${remote}/${dest}: the merge of ${merge.onto.slice(0, 9)}, checked with ${merge.check}`,
				);
				await this.#tellAgent(
					run,
					merge.advanced
						? `Landed on ${remote}/${dest} as a merge with the commits it had gained (${outcome.sha.slice(0, 9)}), after your check passed on that merge. ${run.branch} was fast-forwarded to it, so your worktree now has them too.`
						: `Landed on ${remote}/${dest} as a merge with the commits it had gained (${outcome.sha.slice(0, 9)}), after your check passed on that merge. ${run.branch} moved on meanwhile, so run git fetch ${remote} && git merge ${remote}/${dest} before your next commit.`,
				);
			}
			return;
		}
		if (outcome?.kind === "red") {
			const why = outcome.timedOut ? "timed out" : `exit ${outcome.exitCode ?? "unknown"}`;
			const tail = outcome.tail.trim().split("\n").slice(-15).join("\n");
			await this.#tellAgent(
				run,
				`Not landed: ${remote}/${dest} moved on; it merges with this cycle's commit without conflicts, but your check (${outcome.check}) fails on that merge (${why}). Run git fetch ${remote} && git merge ${remote}/${dest}, fix what the merge broke, run the check, and commit; the next green cycle lands it.${tail ? `\nThe check's last lines:\n${tail}` : ""}`,
			);
			return;
		}
		if (outcome?.kind === "behind") {
			const conflicts = outcome.conflicts ?? [];
			const merge = `git fetch ${remote} && git merge ${remote}/${dest}`;
			await this.#tellAgent(
				run,
				conflicts.length > 0
					? `Not landed: ${remote}/${dest} moved on, and merging it conflicts in ${conflicts.join(", ")}. Run ${merge}, resolve the conflicts keeping both sides' intent, run the check, and commit; the next green cycle lands it.`
					: `Not landed: ${remote}/${dest} has commits this run lacks. Run ${merge}, run the check, and commit; the next green cycle lands it. Never force anything.`,
			);
			return;
		}
		if (outcome?.kind === "pr") {
			if (run.landing) return;
			run.landing = { via: "pr", ...(outcome.url ? { url: outcome.url } : {}), reason: outcome.reason };
			this.#log(
				`${run.tabId}: ${remote}/${dest} refused the land (${outcome.reason}); lands go to ${outcome.url ?? "a pull request"}`,
			);
			this.#notify(run, {
				kind: "error",
				title: this.#deps.text("autopilot.land.prTitle"),
				body: this.#deps.text("autopilot.land.prBody", { branch: dest, url: outcome.url ?? run.branch }),
			});
			await this.#tellAgent(
				run,
				`${remote}/${dest} refused a direct push (${outcome.reason}). Green cycles now update ${run.branch} and its pull request ${outcome.url ?? ""} instead; keep working as before.`,
			);
			await this.#refresh(run);
			return;
		}
		await this.#tellAgent(
			run,
			`Landing on ${remote}/${dest} failed: ${result.item.detail ?? "unknown reason"}. Nothing was forced; the next green cycle tries again.`,
		);
	}

	/** A note the next `begin` hands the agent (what only main saw: a failed push, a failed release run). */
	async #tellAgent(run: Run, text: string): Promise<void> {
		await this.#bridge(run.tabId, AUTOPILOT_BRIDGE_METHODS.note, { text }).catch(error =>
			this.#log(`note: ${String(error)}`),
		);
	}

	/**
	 * The run went quiet (plan mode, every todo blocked, no turn started, a failed turn nobody retries): leave plan mode and
	 * ask for the next cycle. Never a pause; at most one ask per {@link NUDGE_MS}. An ask inside that window is asked again
	 * once it passes, never dropped: a failed turn reports its failure once, so nothing else would wake the run. The run is
	 * checked right before the ask, since it runs from the cycle-end queue and the user may pause or stop meanwhile.
	 */
	async #nudge(run: Run, reason: AutopilotNudgeReason | "error"): Promise<void> {
		const now = this.#now();
		if (run.stopping) return;
		if (now < run.nextNudgeAt) {
			if (run.nudgeLater) return;
			run.nudgeLater = true;
			(this.#deps.after ?? afterMs)(() => {
				run.nudgeLater = false;
				this.#enqueue(run, () => this.#nudge(run, reason));
			}, run.nextNudgeAt - now);
			return;
		}
		if (!(await this.#quietAndRunning(run))) return;
		run.nextNudgeAt = now + (reason === "error" ? ERROR_NUDGE_MS : NUDGE_MS);
		if (reason === "plan") {
			await this.#stock(run.tabId, { type: "set_plan_mode", enabled: false }).catch(() => undefined);
			if (!(await this.#quietAndRunning(run))) return;
		}
		await this.#stockResponse(run.tabId, {
			type: "prompt",
			message: NUDGE_MESSAGE,
			streamingBehavior: "followUp",
		}).catch(error => this.#log(`nudge: ${String(error)}`));
	}

	/**
	 * A turn ended on the account's usage limit and stock's auto-retry let it go: the run waits until the provider's
	 * first account resets (its usage reports; {@link QUOTA_FALLBACK_MS} when none names a reset), journaled as
	 * `waiting_quota` with that time so every window, a paired device and a relaunch see it. Main owns the wake: it
	 * fires with no window open. Never a pause.
	 */
	async #waitForQuota(run: Run): Promise<void> {
		if (this.#runs.get(run.tabId) !== run || run.stopping) return;
		const facts = this.#deps.pool.tabFacts(run.tabId);
		if (!facts || facts.busy || facts.retrying) return;
		const status = await this.#fetchStatus(run).catch(() => null);
		if (status?.state !== "running") return;
		const state = await this.#stock<{ model?: { provider?: string } | null }>(run.tabId, { type: "get_state" }).catch(
			() => null,
		);
		const usage = await this.#stock<{ reports?: UsageReport[] }>(run.tabId, { type: "get_usage" }).catch(() => null);
		const now = this.#now();
		const reports = Array.isArray(usage?.reports) ? usage.reports : [];
		const resetAt = quotaResetAt(reports, state?.model?.provider ?? undefined, now) ?? now + QUOTA_FALLBACK_MS;
		await this.#setState(run, { state: "waiting_quota", quotaResetAt: resetAt });
		this.#armQuotaWake(run, resetAt, false);
	}

	#armQuotaWake(run: Run, at: number, restarted: boolean): void {
		run.cancelQuotaWake?.();
		run.cancelQuotaWake = (this.#deps.after ?? afterMs)(
			() => {
				run.cancelQuotaWake = null;
				this.#enqueue(run, () => this.#quotaWake(run, restarted));
			},
			Math.max(0, at - this.#now()),
		);
	}

	/**
	 * The reset came: a run still waiting (not paused, stopped or resumed meanwhile) goes on. In this process stock's
	 * `retry` takes the failed turn up again; after a relaunch stock paused the goal at startup, so it resumes as a
	 * restart does.
	 */
	async #quotaWake(run: Run, restarted: boolean): Promise<void> {
		if (this.#runs.get(run.tabId) !== run || run.stopping) return;
		const status = await this.#fetchStatus(run).catch(() => null);
		if (status?.state !== "waiting_quota") return;
		await this.#setState(run, { state: "running" });
		if (restarted) {
			await this.#continueOrPause(run);
			return;
		}
		const retried = await this.#stockResponse(run.tabId, { type: "retry" }).catch(() => null);
		if (!retried?.success) this.#enqueue(run, () => this.#nudge(run, "error"));
	}

	async #stopRequested(run: Run, request: AutopilotStopRequest): Promise<void> {
		if (run.stopping) return;
		if (request.end) {
			await this.#beginStop(run, request.reason as AutopilotEndReason);
			return;
		}
		await this.#pause(run, request.reason as AutopilotPauseReason, request.detail);
	}

	async #pause(run: Run, reason: AutopilotPauseReason, detail?: string): Promise<void> {
		if (run.stopping) return;
		await this.#stock(run.tabId, { type: "set_goal", action: "pause" }).catch(() => undefined);
		await this.#setState(run, { state: "paused", reason, ...(detail ? { detail } : {}) });
		await this.#reportStop(run, "paused", reason, detail);
	}

	/** The last turn of a stopping run settled. */
	async #settled(run: Run, reason: AutopilotPauseReason | AutopilotEndReason): Promise<void> {
		await this.#closeChildren(run, run.status?.cycle ?? 0);
		await this.#drain(run);
		run.stopPolling?.();
		run.stopPolling = null;
		const ending = (reason as string) === "user" || reason === "agent_done" || reason === "tab_closed";
		if (!ending) {
			await this.#setState(run, { state: "paused", reason: reason as AutopilotPauseReason });
			run.stopping = false;
			await this.#reportStop(run, "paused", reason, undefined);
			return;
		}
		const summary = await this.#summary(run, reason, undefined);
		await this.#setState(run, { state: "ended", reason });
		await this.#stock(run.tabId, { type: "set_goal", action: "drop" }).catch(() => undefined);
		await this.#bridge(run.tabId, AUTOPILOT_BRIDGE_METHODS.disarm, {}).catch(error =>
			this.#log(`disarm: ${String(error)}`),
		);
		this.#deps.runLog?.("ended", summary.details);
		this.#notify(run, { kind: "completion", title: this.#deps.text("autopilot.ended.title"), body: summary.line });
		this.#runs.delete(run.tabId);
		this.#deps.runEnded?.(run.root);
	}

	// ----------------------------------------------------------------------------------------
	// Children (DeskTools hooks)
	// ----------------------------------------------------------------------------------------

	/** `AgentControlHostDeps.beforeFirstPrompt`: arm a session the run opened before it gets its prompt. */
	async beforeFirstPrompt(child: {
		tabId: string;
		callerTabId: string;
		worktree?: { path: string; branch: string };
		tag?: string;
	}): Promise<void> {
		// The tool path (`ompdesk_session_open`) passes no tag, so every session an autopilot run's tab opens is its child;
		// a tagged one whose caller is no run (a stale tag) is refused below.
		if (child.tag !== AUTOPILOT_CHILD_TAG && !this.#runs.has(child.callerTabId)) return;
		const run = this.#runs.get(child.callerTabId);
		if (!run) throw new Error("Autopilot is not running in the session that opened this one.");
		if (run.stopping) throw new Error("Autopilot is ending: start nothing new.");
		if (run.settings.maxParallel !== null && run.children.size >= run.settings.maxParallel) {
			throw new Error(`Autopilot allows at most ${run.settings.maxParallel} parallel sessions per cycle.`);
		}
		const root = child.worktree?.path ?? this.#deps.pool.sidecarOf(child.tabId)?.cwd ?? run.root;
		const branch = child.worktree?.branch ?? "";
		const arm: AutopilotArmParams = {
			role: "child",
			root,
			run: run.run,
			branch,
			baseBranch: run.branch,
			settings: {
				...run.settings,
				ship: { ...DEFAULT_SHIP_POLICY, remote: run.settings.ship.remote },
				limits: NO_LIMITS,
			},
			parentTab: run.tabId,
		};
		await this.#bridge(child.tabId, AUTOPILOT_BRIDGE_METHODS.arm, arm);
		this.#childRuns.set(child.tabId, { parentTab: run.tabId, root, branch });
		run.children.set(child.tabId, {
			tabId: child.tabId,
			...(branch ? { branch } : {}),
			...(child.worktree ? { worktree: child.worktree.path } : {}),
		});
		if (branch) run.childBranches.add(branch);
		this.#track(this.#refresh(run));
	}

	/** Usage of every child of the cycle, its tab closed and its clean, merged worktree removed. */
	async #closeChildren(run: Run, cycle: number): Promise<void> {
		const children = [...run.children.values()];
		run.children.clear();
		let tokens = 0;
		let usd = 0;
		for (const child of children) {
			const stats = await this.#stock<{ tokens?: { total?: number }; cost?: number }>(child.tabId, {
				type: "get_session_stats",
			}).catch(() => null);
			tokens += stats?.tokens?.total ?? 0;
			usd += stats?.cost ?? 0;
			if (this.#deps.pool.tabFacts(child.tabId)?.busy) {
				this.#deps.pool.noteStopped(child.tabId);
				recordTurnStop({ command: "abort", tab: child.tabId, by: "autopilot", surface: "run-ended" });
				await this.#stock(child.tabId, { type: "abort" }).catch(() => undefined);
			}
			this.#childRuns.delete(child.tabId);
			await this.#deps.pool.releaseTabWhenExited(child.tabId).catch(() => undefined);
			await this.#removeChildWorktree(run, child);
		}
		if (children.length > 0 && (tokens > 0 || usd > 0) && cycle > 0) {
			await this.#bridge(run.tabId, AUTOPILOT_BRIDGE_METHODS.cycleAmend, { n: cycle, tokens, usd }).catch(error =>
				this.#log(`cycle amend: ${String(error)}`),
			);
		}
		if (children.length > 0) this.#track(this.#refresh(run));
	}

	/** `git worktree remove` (no force) when the child's branch is merged into the run's and its tree is clean. */
	async #removeChildWorktree(run: Run, child: ChildState): Promise<void> {
		if (!child.worktree || !child.branch) return;
		const merged = await gitRaw(run.root, ["merge-base", "--is-ancestor", child.branch, run.branch], {
			timeoutMs: GIT_MS,
		}).catch(() => null);
		if (merged?.code !== 0) return;
		const dirty = await gitRaw(child.worktree, ["status", "--porcelain"], { timeoutMs: GIT_MS }).catch(() => null);
		if (dirty?.code !== 0 || dirty.stdout.toString("utf8").trim() !== "") return;
		await gitRaw(run.root, ["worktree", "remove", child.worktree], { timeoutMs: GIT_MS }).catch(() => undefined);
	}

	// ----------------------------------------------------------------------------------------
	// Release run
	// ----------------------------------------------------------------------------------------

	async #releaseReported(run: Run, ship: NonNullable<AutopilotCycleRecord["ship"]>): Promise<void> {
		const item = run.releaseItem ?? run.ship.track({ kind: "release", detail: ship.version }).id;
		run.releaseItem = item;
		if (!ship.runUrl) {
			run.ship.finish(item, "done", ship.version);
			run.releaseItem = undefined;
			await this.#bridge(run.tabId, AUTOPILOT_BRIDGE_METHODS.configure, {
				release: { version: ship.version, state: "success" },
			}).catch(() => undefined);
			return;
		}
		await this.#bridge(run.tabId, AUTOPILOT_BRIDGE_METHODS.configure, {
			release: { version: ship.version, runUrl: ship.runUrl, state: "pending" },
		}).catch(() => undefined);
		this.#pollRelease(run, ship.version, ship.runUrl);
	}

	#pollRelease(run: Run, version: string, runUrl: string): void {
		run.stopPolling?.();
		const setTimer =
			this.#deps.setTimer ??
			((fn, ms) => {
				const timer = setInterval(fn, ms);
				timer.unref?.();
				return () => clearInterval(timer);
			});
		let busy = false;
		const stop = setTimer(() => {
			if (busy) return;
			busy = true;
			this.#track(
				this.#checkRelease(run, version, runUrl, stop)
					.catch(error => this.#log(`release poll: ${String(error)}`))
					.finally(() => {
						busy = false;
					}),
			);
		}, RELEASE_POLL_MS);
		run.stopPolling = stop;
	}

	async #checkRelease(run: Run, version: string, runUrl: string, stop: () => void): Promise<void> {
		const info = await (this.#deps.ghRun ?? ghRunStatus)(run.root, runUrl);
		if (info?.status !== "completed") return;
		stop();
		run.stopPolling = null;
		const ok = info.conclusion === "success";
		const item = run.releaseItem;
		run.releaseItem = undefined;
		if (item) run.ship.finish(item, ok ? "done" : "failed", version, runUrl);
		await this.#bridge(run.tabId, AUTOPILOT_BRIDGE_METHODS.configure, {
			release: { version, runUrl, state: ok ? "success" : "failure" },
		}).catch(() => undefined);
		this.#notify(run, {
			kind: ok ? "completion" : "error",
			title: this.#deps.text("autopilot.release.title"),
			body: this.#deps.text(ok ? "autopilot.release.ok" : "autopilot.release.failed", { version }),
		});
		// A failed release run is reported (notice above, the run's status) and handed to the next cycle: never a pause.
		if (!ok) {
			await this.#tellAgent(
				run,
				`The release run of ${version} failed (${info.conclusion ?? "failed"}): ${runUrl}. Read the failure, fix it and release again.`,
			);
		}
	}

	// ----------------------------------------------------------------------------------------
	// Notifications
	// ----------------------------------------------------------------------------------------

	/**
	 * Stops, ends and release outcomes: what a person away from the screen must know. Where it goes (this computer's
	 * banner under its own notifications switch, the paired device that started or shows the run, phones) is `notify`'s.
	 */
	#notify(run: Run, notice: AutopilotNotice): void {
		this.#deps.notify(run.tabId, notice);
	}

	/**
	 * A run paused: the summary line goes to the runtime log always and to a notification unless the pause is the user's
	 * own doing or a state the screen already shows ({@link SILENT_REASONS}).
	 */
	async #reportStop(run: Run, state: "paused", reason: string, detail: string | undefined): Promise<void> {
		const summary = await this.#summary(run, reason, detail);
		this.#deps.runLog?.(state, summary.details);
		if (SILENT_REASONS.has(reason)) return;
		this.#notify(run, {
			kind: COMPLETION_REASONS.has(reason) ? "completion" : "error",
			title: this.#deps.text("autopilot.paused.title"),
			body: summary.line,
		});
	}

	/**
	 * One line that says what the run did and why it stopped: cycles (green), commits, whether they reached the default
	 * branch (landing), the pushed branch, or only this computer, and the reason. Read from the journal and git, so it is
	 * right after a relaunch too; it is the record that outlives the run's session.
	 */
	async #summary(
		run: Run,
		reason: string,
		detail: string | undefined,
	): Promise<{ line: string; details: Record<string, string | number | boolean> }> {
		const text = this.#deps.text;
		const status = await this.#fetchStatus(run).catch(() => run.status);
		const cycles = status?.cycles ?? [];
		const commits = cycles.flatMap(cycle => (cycle.commit ? [cycle.commit] : []));
		const green = cycles.filter(cycle => cycle.verify === "green").length;
		const remote = run.settings.ship.remote;
		const contains = async (ref: string, sha: string) =>
			(await gitRaw(run.root, ["merge-base", "--is-ancestor", sha, ref], { timeoutMs: GIT_MS }).catch(() => null))
				?.code === 0;
		let shipped: string;
		const details: Record<string, string | number | boolean> = {};
		if (run.settings.ship.land && run.landTo) {
			const ref = `refs/remotes/${remote}/${run.landTo}`;
			let landed = 0;
			for (const sha of commits) if (await contains(ref, sha)) landed++;
			details.landed = landed;
			details.landTo = run.landTo;
			shipped = run.landing
				? text("autopilot.summary.pr", {
						landed,
						commits: commits.length,
						target: run.landTo,
						url: run.landing.url ?? run.branch,
					})
				: text("autopilot.summary.landed", { landed, commits: commits.length, target: run.landTo });
			if (run.landing?.url) details.pr = run.landing.url;
		} else if (run.settings.ship.autoPush || run.settings.ship.autoRelease.on) {
			const dest = run.target ?? run.branch;
			const last = commits.at(-1);
			const pushed = last ? await contains(`refs/remotes/${remote}/${dest}`, last) : false;
			details.pushed = pushed;
			shipped = pushed
				? text("autopilot.summary.pushed", { target: `${remote}/${dest}` })
				: text("autopilot.summary.notPushed");
		} else {
			shipped = text("autopilot.summary.local");
		}
		const key = REASON_TEXT[reason as AutopilotPauseReason | AutopilotEndReason];
		const why = key ? text(key, { detail: detail ?? "" }) : detail ? `${reason}: ${detail}` : reason;
		const line = text("autopilot.summary", {
			branch: run.branch,
			cycles: cycles.length,
			green,
			commits: commits.length,
			shipped,
			reason: why,
		});
		return {
			line,
			details: {
				summary: line,
				run: run.run,
				root: run.root,
				branch: run.branch,
				reason,
				...(detail ? { detail } : {}),
				cycles: cycles.length,
				green,
				commits: commits.length,
				...details,
			},
		};
	}

	// ----------------------------------------------------------------------------------------
	// Plumbing
	// ----------------------------------------------------------------------------------------

	#approverRun(tabId: string): ApproverRun | undefined {
		const run = this.#runs.get(tabId);
		if (run) {
			return {
				role: "parent",
				root: run.root,
				ship: run.settings.ship,
				oneShotRelease: run.settings.ship.autoRelease.on || run.releaseRequested,
				defaultBranch: run.baseBranch,
			};
		}
		const child = this.#childRuns.get(tabId);
		const parent = child ? this.#runs.get(child.parentTab) : undefined;
		if (!child || !parent) return undefined;
		return {
			role: "child",
			root: child.root,
			ship: DEFAULT_SHIP_POLICY,
			oneShotRelease: false,
			defaultBranch: parent.baseBranch,
		};
	}

	#overlaid(run: Run, status: AutopilotStatus): AutopilotStatus {
		const ship: AutopilotShipState = {
			...(status.ship ?? { policy: run.settings.ship, queue: [] }),
			queue: run.ship.queue(),
			...(run.releaseProcedure ? { releaseProcedure: run.releaseProcedure } : {}),
			...(run.releaseBlocked && !run.releaseProcedure ? { releaseBlocked: run.releaseBlocked } : {}),
			...(run.landing ? { landing: run.landing } : {}),
		};
		const children: AutopilotChildLive[] = [...run.children.values()].map(child => ({
			tabId: child.tabId,
			...(child.area ? { area: child.area } : {}),
			...(child.branch ? { branch: child.branch } : {}),
			status: this.#deps.pool.tabFacts(child.tabId)?.busy ? "running" : "done",
		}));
		return { ...status, ship, children };
	}

	async #fetchStatus(run: Run): Promise<AutopilotStatus> {
		const status = await this.#bridge<AutopilotStatus>(run.tabId, AUTOPILOT_BRIDGE_METHODS.status, {});
		run.status = status;
		if (status.settings) run.settings = status.settings;
		return status;
	}

	/** Make the bridge re-emit `autopilot_update` (through the overlay) after something only main changed. */
	async #refresh(run: Run): Promise<void> {
		if (run.refreshing) {
			run.refreshAgain = true;
			return;
		}
		run.refreshing = true;
		try {
			do {
				run.refreshAgain = false;
				await this.#bridge(run.tabId, AUTOPILOT_BRIDGE_METHODS.configure, {}).catch(() => undefined);
			} while (run.refreshAgain);
		} finally {
			run.refreshing = false;
		}
	}

	/** Journal a state through the bridge, keeping what the last status said about the rest. */
	async #setState(
		run: Run,
		change: {
			state?: AutopilotStatus["state"];
			reason?: AutopilotPauseReason | AutopilotEndReason;
			detail?: string;
			inFlight?: { kind: "push" | "release"; startedAt: number } | null;
			quotaResetAt?: number;
		},
	): Promise<void> {
		const current = run.status;
		const sameState = change.state === undefined || change.state === current?.state;
		const reason = change.reason ?? (sameState ? current?.reason : undefined);
		const detail = change.detail ?? (sameState ? current?.detail : undefined);
		await this.#bridge(run.tabId, AUTOPILOT_BRIDGE_METHODS.setState, {
			state: change.state ?? current?.state ?? "running",
			...(reason ? { reason } : {}),
			...(detail ? { detail } : {}),
			...(change.inFlight !== undefined ? { inFlight: change.inFlight } : {}),
			...(change.quotaResetAt !== undefined ? { quotaResetAt: change.quotaResetAt } : {}),
		});
	}

	async #bridge<T = unknown>(tabId: string, method: string, params: unknown, timeoutMs?: number): Promise<T> {
		const client = this.#deps.pool.sidecarOf(tabId)?.rpcClient;
		if (!client) throw new Error("That session's process is gone.");
		const response = await client.command({ type: "autopilot_bridge", method, params }, timeoutMs);
		if (!response.success) throw new Error(response.error ?? `${method} failed`);
		return response.data as T;
	}

	async #stockResponse(tabId: string, command: Record<string, unknown>): Promise<RpcResponse> {
		const client = this.#deps.pool.sidecarOf(tabId)?.rpcClient;
		if (!client) throw new Error("That session's process is gone.");
		// The coordinator speaks stock command names; RpcCommand only types the renderer's set.
		return client.command(command as unknown as RpcCommand);
	}

	async #stock<T = unknown>(tabId: string, command: Record<string, unknown>): Promise<T> {
		const response = await this.#stockResponse(tabId, command);
		if (!response.success) throw new Error(response.error ?? `${String(command.type)} failed`);
		return response.data as T;
	}

	/** Names the run's session (`runSessionTitle`); a later rename only replaces the run's own title, never the user's. */
	async #retitle(run: Run, what: string): Promise<void> {
		const name = runSessionTitle(this.#deps.text("autopilot.sessionTitle"), what);
		try {
			if (run.title) {
				const state = await this.#stock<{ sessionName?: string | null }>(run.tabId, { type: "get_state" });
				if ((state.sessionName ?? "") !== run.title.name) return;
			}
			await this.#stock(run.tabId, { type: "set_session_name", name });
			this.#deps.pool.noteSessionName(run.tabId, name);
			run.title = { name, item: run.title?.item ?? false };
		} catch (error) {
			this.#log(`naming the run's session failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #ready(tabId: string): Promise<SidecarLike> {
		const sidecar = this.#deps.pool.sidecarOf(tabId);
		if (!sidecar) throw new Error("The Autopilot tab is gone.");
		if (sidecar.status === "ready") return sidecar;
		const { promise, resolve, reject } = Promise.withResolvers<SidecarLike>();
		const timer = setTimeout(
			() => finish(new Error("The Autopilot session did not start in time.")),
			READY_TIMEOUT_MS,
		);
		const listener = (payload: { status: string }) => {
			if (payload.status === "ready") finish(null);
			else if (payload.status === "error" || payload.status === "exited")
				finish(new Error("The Autopilot session failed to start."));
		};
		const finish = (error: Error | null) => {
			clearTimeout(timer);
			sidecar.off("status", listener);
			if (error) reject(error);
			else resolve(sidecar);
		};
		sidecar.on("status", listener);
		// A tab nobody has shown yet may still be asleep.
		if (sidecar.status === "asleep") sidecar.start();
		return promise;
	}

	/** The remote a run ships to when nothing says: `origin`, else the only (first) remote, else `origin` anyway. */
	async #detectRemote(cwd: string): Promise<string> {
		const names = (await this.#gitText(cwd, ["remote"])).split("\n").filter(Boolean);
		return names.includes("origin") ? "origin" : (names[0] ?? "origin");
	}

	/** `gone` only when two probes {@link REPO_RECHECK_MS} apart both say so; `unknown` when git could not answer. */
	async #repoState(root: string): Promise<RepoProbe> {
		const probe = this.#deps.probeRepo ?? probeRepo;
		const first = await probe(root);
		if (first !== "gone") return first;
		const { promise, resolve } = Promise.withResolvers<void>();
		(this.#deps.after ?? afterMs)(resolve, REPO_RECHECK_MS);
		await promise;
		return probe(root);
	}

	async #gitText(cwd: string, args: string[]): Promise<string> {
		const result = await gitRaw(cwd, args, { timeoutMs: GIT_MS }).catch(() => null);
		return result?.code === 0 ? result.stdout.toString("utf8").trim() : "";
	}

	/**
	 * Writes Start's guide into the new worktree and commits it as the autopilot branch's first commit; nothing happens
	 * when the worktree's own AUTOPILOT.md already says the same. Hooks are skipped (a docs-only commit must not be able
	 * to stop the start) and so is signing. The user's own branch is never written.
	 */
	async #commitGuide(root: string, guide: string): Promise<void> {
		const body = `${guide.trim()}\n`;
		if (Buffer.byteLength(body) > AUTOPILOT_GUIDE_COMMIT_MAX_BYTES) {
			throw new AutopilotError(this.#deps.text("autopilot.err.guideTooLarge"), "autopilot_guide_large");
		}
		const file = join(root, AUTOPILOT_GUIDE_FILE);
		const current = await readFile(file, "utf8").catch(() => null);
		if (current !== null && `${current.trim()}\n` === body) return;
		await writeFile(file, body, "utf8");
		const message = current === null ? "docs: add AUTOPILOT.md guide" : "docs: update AUTOPILOT.md guide";
		const steps = [
			["add", "--", AUTOPILOT_GUIDE_FILE],
			["-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", message, "--", AUTOPILOT_GUIDE_FILE],
		];
		for (const args of steps) {
			const result = await gitRaw(root, args, { timeoutMs: GIT_MS }).catch(() => null);
			if (result?.code !== 0) {
				const why = result?.stderr.trim() || "git failed";
				throw new AutopilotError(
					`${this.#deps.text("autopilot.err.guideCommit")} ${why}`,
					"autopilot_guide_commit",
				);
			}
		}
	}

	/** Start's guide from the bridge (see {@link AUTOPILOT_BRIDGE_METHODS.guide}); null when the bridge cannot build one. */
	async #guideToCommit(
		tabId: string,
		root: string,
		procedure: AutopilotReleaseProcedure | null,
		text: string | undefined,
	): Promise<AutopilotEnsuredGuide | null> {
		const guide = await this.#bridge<unknown>(
			tabId,
			AUTOPILOT_BRIDGE_METHODS.guide,
			{ root, procedure, ...(typeof text === "string" && text.trim() ? { text } : {}) },
			GUIDE_MS,
		).catch(() => null);
		if (typeof guide !== "object" || guide === null || !("text" in guide) || typeof guide.text !== "string")
			return null;
		return guide.text.trim() ? (guide as AutopilotEnsuredGuide) : null;
	}

	/** What the start sheet needs of a session that is no run: ship defaults, release facts, the branches. */
	async #idleStatus(sidecar: SidecarLike): Promise<AutopilotStatus> {
		const release = await this.#releaseFor(sidecar.cwd);
		// git prints `C:/x` on Windows; the sheet's key and the folders the picker names are native paths.
		const topText = await this.#gitText(sidecar.cwd, ["rev-parse", "--show-toplevel"]);
		const toplevel = topText ? resolve(topText) : topText;
		const remote = await this.#detectRemote(sidecar.cwd);
		const branches = toplevel ? await readBranchInfo(sidecar.cwd, { toplevel, remote }).catch(() => null) : null;
		return {
			active: false,
			ship: {
				policy: { ...DEFAULT_SHIP_POLICY, remote },
				queue: [],
				...(release.procedure ? { releaseProcedure: release.procedure } : {}),
				...(release.blocked ? { releaseBlocked: release.blocked } : {}),
			},
			...(branches ? { branches } : {}),
		};
	}

	/** Throws the reason a run cannot take `choice` (git's own state, read at the start). */
	#refuseBranch(choice: AutopilotBranchChoice, entries: readonly AutopilotBranchEntry[]): void {
		const problem = branchProblem(choice, entries);
		if (!problem) return;
		const text = this.#deps.text;
		const branch = choice.kind === "new" ? (choice.name ?? "") : choice.name;
		if (problem.code === "exists") {
			throw new AutopilotError(text("autopilot.err.branchExists", { branch }), "autopilot_branch_exists");
		}
		if (problem.code === "invalid_name") {
			throw new AutopilotError(text("autopilot.err.branchInvalid", { branch }), "autopilot_branch_invalid");
		}
		throw new AutopilotError(text("autopilot.err.branchMissing", { branch }), "autopilot_branch_missing");
	}

	/** The checkout the worktree was cut from: the first entry of `git worktree list` (the primary one). */
	async #commonCheckout(root: string): Promise<string | null> {
		const list = await this.#gitText(root, ["worktree", "list", "--porcelain"]);
		const first = /^worktree (.+)$/m.exec(list)?.[1];
		return first ?? null;
	}

	/** The release procedure of the repository at `root` (cached a minute), or why there is none. */
	async #releaseFor(root: string): Promise<{ procedure: AutopilotReleaseProcedure | null; blocked?: string }> {
		const cached = this.#releaseCache.get(root);
		const now = this.#now();
		let value: AutopilotReleaseProcedure | null;
		if (cached && now - cached.at < RELEASE_CACHE_MS) value = cached.value;
		else {
			value = await (this.#deps.detectRelease ?? detectReleaseProcedure)(root).catch(() => null);
			this.#releaseCache.set(root, { at: now, value });
		}
		return value ? { procedure: value } : { procedure: null, blocked: this.#deps.text("autopilot.err.noRelease") };
	}

	#now(): number {
		return this.#deps.now?.() ?? Date.now();
	}

	#log(message: string): void {
		(this.#deps.log ?? ((text: string) => console.warn(`[autopilot] ${text}`)))(message);
	}

	/** Resolves when every queued cycle-end/stop task and every background step of every run has finished (tests, quit). */
	async idle(): Promise<void> {
		for (;;) {
			const chains = [...this.#runs.values()].map(run => [run, run.chain] as const);
			await Promise.allSettled([...this.#background, ...chains.map(([, chain]) => chain)]);
			await this.#approver.idle();
			// A task that queued another (a stop that settles itself) moved a chain on.
			if (this.#background.size === 0 && chains.every(([run, chain]) => run.chain === chain)) return;
		}
	}

	#track(work: Promise<unknown>): void {
		this.#background.add(work);
		void work.finally(() => this.#background.delete(work));
	}
}
