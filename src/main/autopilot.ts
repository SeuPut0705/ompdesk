/**
 * Autopilot's coordinator, main process side. Autopilot is a stock Goal with a marker: the bridge keeps the cycle ledger
 * in the session journal and enforces the protocol inside the agent (modes/autopilot.ts); the run's state machine (start,
 * stop, each cycle's end with the children, the git audit and the ShipRunner, the nudge, the quota wait, the restart
 * resume, the release run, the summary) is the core's (`native/ompdesk/crates/core/src/autopilot/`; docs/rust-remaining-
 * units.md §2.4, units 9m and 9n). This class is its typed client:
 *
 * - it keeps the public methods its callers use (`ipc.ts`, the pool, the sidecar factory, TurnResume, the control tools)
 *   and turns each into a call or an event for the core, applied in the order main sent them;
 * - it answers what the core asks of main through one port (`core/ports.ts`): a tab's omp (stock commands and the
 *   bridge), the pool's facts, the windows (`dispatch`, `spawnTab`), the notice and the log, text, and the rules that stay
 *   here because the page, the bridge or turn-resume share them (the approval rules, the log's Markdown, the quota wait,
 *   the release procedure);
 * - it keeps a mirror of what its synchronous callers read (`isStopping`, `runRootOf`, `holdsLimitWait`, the status
 *   overlay and the approver's view of a run), written only from the core's `mirror` and `childRun` events.
 *
 * What the TypeScript read synchronously is read from that mirror, so a read made right after a command sees the run as it
 * was when the core answered that command (the events come before the answer), and a status frame the overlay saw reaches
 * the core's copy a moment later (`status` event) instead of in the same tick.
 */
import {
	AUTOPILOT_BRIDGE_METHODS,
	AUTOPILOT_CHILD_TAG,
	AUTOPILOT_GUIDE_COMMIT_MAX_BYTES,
	AUTOPILOT_GUIDE_FILE,
	AUTOPILOT_OBJECTIVE,
	type AutopilotAction,
	type AutopilotChildLive,
	type AutopilotReleaseProcedure,
	type AutopilotShipPolicy,
	type AutopilotShipState,
	type AutopilotStall,
	type AutopilotStatus,
	DEFAULT_SHIP_POLICY,
	NO_LIMITS,
	type ShipQueueItem,
	shipPolicyForPreset,
	withRecentCycles,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { autopilotLogTitle, formatAutopilotLog } from "../shared/autopilot-log";
import { withoutGitSelectors } from "../shared/git-env";
import type { IpcSpawnTabPayload, IpcSpawnTabResult } from "../shared/ipc-types";
import { isLimitWording, quotaWaitUntil } from "../shared/quota-reset";
import type { RpcCommand, RpcResponse, UsageReport } from "../shared/rpc-types";
import { type ApproverRun, AutopilotApprover } from "./autopilot-approver";
import { CorePort } from "./core/ports";
import { type CoreAnswer, core } from "./core/process";
import { ghText, gitRunner, resolveBin } from "./local/git/exec";
import { prCreate } from "./local/git/pr";
import { prepareWorktree } from "./local/git/worktree-seed";
import { nativeBinPath } from "./native-bin";
import { detectReleaseProcedure } from "./release-detect";
import { findGitBash } from "./setup/paths";
import { shellSpawnEnv } from "./shell-env";
import type { MainTextKey } from "./shell-host/modules/boot";
import type { TabActivity } from "./sidecar-pool";
import type { SidecarLike } from "./sidecar-types";
import { findOnPath } from "./spawn";
import type { GoalSettlement, RelaunchContinuation } from "./turn-resume";
import { recordTurnStop } from "./turn-stop-log";
import type { ClientWindow } from "./web/client-window";

/** The wire has no deadline of its own for a command: a start waits for its tab's omp for as long as it takes. */
const NO_DEADLINE_MS = 2 ** 31 - 1;

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
	routeSideChannel(id: string, frame: object, tabId?: string): Promise<boolean>;
}

/** DeskTools' side (`AgentControl`): emptying a child's queue without aborting it. */
export interface AutopilotControl {
	clearQueue(tabId: string): Promise<void>;
}

export interface AutopilotNotice {
	kind: "completion" | "error";
	title: string;
	body: string;
}

/**
 * The core's clock runs its own timers, so the durations a parity suite cannot wait out are `tuning` (all in ms; the
 * core's own defaults when absent): see `Tuning` in `crates/core/src/autopilot/mod.rs`.
 */
export interface AutopilotTuning {
	releasePollMs?: number;
	releaseCacheMs?: number;
	errorGraceMs?: number;
	stepMaxMs?: number;
	cycleEndMaxMs?: number;
	shipDrainMaxMs?: number;
	nudgeMs?: number;
	errorNudgeMs?: number;
	quotaRetryMinMs?: number;
	quotaRetryMaxMs?: number;
	repoRecheckMs?: number;
	landStopGraceMs?: number;
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
	/** Test seams; defaults are the local date and the repository's rules files. */
	today?: () => string;
	detectRelease?: (root: string) => Promise<AutopilotReleaseProcedure | null>;
	/** A stand-in for the core's look at a run's folder; absent: the core looks itself. */
	probeRepo?: (root: string) => Promise<"present" | "gone" | "unknown">;
	log?: (message: string) => void;
	/**
	 * The run's summary, written when it ends or pauses (gui-runtime.jsonl, source `autopilot`): it outlives the run's
	 * session, which a person may delete.
	 */
	runLog?: (message: string, details: Record<string, string | number | boolean>) => void;
	tuning?: AutopilotTuning;
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
export type AutopilotCommand =
	| { type: "get_autopilot"; allCycles?: boolean }
	| ({ type: "set_autopilot" } & AutopilotAction);

/** `YYYY-MM-DD` in local time: the run id and the branch suffix. */
export function localDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The shell the agent's bash tool would run it in: bash (with pipefail, so `cmd | tail` fails when cmd does), else sh. */
function shellFor(command: string, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
	if (process.platform === "win32") {
		const bash = findGitBash(env);
		if (bash) return { file: bash, args: ["-o", "pipefail", "-c", command] };
		return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
	}
	const bash = findOnPath(["bash"], env.PATH ?? "", process.platform === "darwin" ? "darwin" : "linux", ["/bin/bash"]);
	return bash ? { file: bash, args: ["-o", "pipefail", "-c", command] } : { file: "/bin/sh", args: ["-c", command] };
}

/**
 * The shell and environment a land check's command runs in, and the supervisor that holds it: the login shell's PATH and
 * exports under the app's own (`shellSpawnEnv`, as `SidecarManager` spawns). A Finder-launched app's own PATH is launchd's
 * bare one, where the cycle's `bun run check` was "command not found" and no green cycle ever landed over a moved default
 * branch.
 */
export async function landShell(command: string): Promise<{
	env: Record<string, string>;
	file: string;
	args: string[];
	supervisor: string;
}> {
	const merged = withoutGitSelectors({ ...process.env, ...(await shellSpawnEnv()) });
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(merged)) if (value !== undefined) env[name] = value;
	return { env, ...shellFor(command, merged), supervisor: nativeBinPath("ompdesk-core") };
}

/** What the core mirrors of a run for the callers that read it synchronously (`Run`'s `mirror` in `run.rs`). */
interface RunMirror {
	tab: string;
	root: string;
	baseBranch: string;
	stopping: boolean;
	oneShotRelease: boolean;
	children: Array<{ tabId: string; area?: string; branch?: string }>;
	queue: ShipQueueItem[];
	policy: AutopilotShipPolicy;
	releaseProcedure?: AutopilotReleaseProcedure;
	releaseBlocked?: string;
	landing?: { via: "pr"; url?: string; reason: string };
	endAfterShip: boolean;
	stalls: AutopilotStall[];
}

type MirrorEvent = RunMirror | { tab: string; gone: true };

/** What the core answers a command with (`status_answer` and the failure in `coordinator.rs`). */
type CommandAnswer =
	| { ok: true; status: AutopilotStatus; overlay: boolean; tabId?: string }
	| { ok: false; error: string; code?: string };

export class Autopilot {
	readonly #deps: AutopilotDeps;
	readonly #port: CorePort;
	readonly #approver: AutopilotApprover;
	readonly #tabOf = new WeakMap<object, string>();
	/** What the core says of each run and of each child tab of a run. */
	readonly #mirror = new Map<string, RunMirror>();
	readonly #childRuns = new Map<string, { parentTab: string; root: string }>();
	/** The window and tab a command in flight came from (`dispatch` and `spawnTab` of its start need them). */
	readonly #calls = new Map<number, { win: ClientWindow; sidecar: SidecarLike }>();
	/** A start's wait for its new tab's omp, by tab: calls it off when the core ends the wait. */
	readonly #readyCancels = new Map<string, () => void>();
	#callSeq = 0;
	#control: AutopilotControl | null = null;
	/** The core this was opened on: another process id is a core that started again, which lost the runs it held. */
	#pid: number | null = null;

	constructor(deps: AutopilotDeps) {
		this.#deps = deps;
		this.#port = new CorePort(this.#handlers());
		this.#approver = new AutopilotApprover({
			runOf: tabId => this.#approverRun(tabId),
			answer: async (tabId, response) => {
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
	// The core
	// ----------------------------------------------------------------------------------------

	/**
	 * Opens the coordinator in the core on first use, and again when the core started anew. Every call after it is made in
	 * the same tick, so the core applies them in the order this side made them.
	 */
	#open(): void {
		const pid = core().pid;
		if (this.#pid !== null && pid === this.#pid) return;
		this.#mirror.clear();
		this.#childRuns.clear();
		const tuning = this.#deps.tuning ?? {};
		core()
			.call("autopilot.open", {
				port: this.#port.id,
				...this.#port.first(),
				contracts: {
					bridge: AUTOPILOT_BRIDGE_METHODS,
					objective: AUTOPILOT_OBJECTIVE,
					guideFile: AUTOPILOT_GUIDE_FILE,
					guideCommitMaxBytes: AUTOPILOT_GUIDE_COMMIT_MAX_BYTES,
					childTag: AUTOPILOT_CHILD_TAG,
					defaultShipPolicy: DEFAULT_SHIP_POLICY,
					noLimits: NO_LIMITS,
					presets: Object.fromEntries(
						(["local", "push", "release"] as const).map(preset => [preset, shipPolicyForPreset(preset)]),
					),
				},
				tuning,
				probeOverride: this.#deps.probeRepo !== undefined,
			})
			.catch(error => this.#log(`autopilot.open: ${String(error)}`));
		this.#pid = core().pid;
	}

	/** An event for the core: applied in the order it was sent. */
	#tell(method: string, params: Record<string, unknown>): void {
		this.#open();
		core()
			.call(`autopilot.${method}`, { port: this.#port.id, ...params })
			.catch(error => this.#log(`autopilot.${method}: ${String(error)}`));
	}

	async #ask<T>(method: string, params: Record<string, unknown>): Promise<T> {
		this.#open();
		const answer: CoreAnswer<T> = await core().call<T>(
			`autopilot.${method}`,
			{ port: this.#port.id, ...params },
			{ timeoutMs: NO_DEADLINE_MS },
		);
		return answer.result;
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
			if (payload.status === "ready") this.#tell("ready", { tab: tabId });
		});
	}

	/** The pool released the tab (closed by the user, or by us). */
	tabReleased(tabId: string): void {
		this.#tell("released", { tab: tabId });
	}

	/**
	 * The pool's tab activity (`observeTabs`): a released tab ends its run; a failed turn that neither stock's auto-retry
	 * nor TurnResume's scheduled retries will take up (they are spent) gets a nudge for the next cycle, never a pause. A
	 * usage limit waits in the core: journaled `waiting_quota` with its reset, woken at it.
	 */
	observeActivity(activity: TabActivity): void {
		if (activity.type === "released") {
			this.tabReleased(activity.tabId);
			return;
		}
		if (activity.type !== "idle" || activity.outcome?.stopReason !== "error") return;
		if (!this.#mirror.has(activity.tabId)) return;
		const kind = isLimitWording(activity.outcome.errorMessage ?? "") ? "limit" : "error";
		this.#tell("activity", { tab: activity.tabId, kind });
	}

	/** The sidecar factory's `frameTransform` for `autopilot_update`: the status plus what only main knows. */
	overlay(sidecar: object, frame: Record<string, unknown>): Record<string, unknown> {
		const tabId = this.#tabOf.get(sidecar);
		const run = tabId ? this.#mirror.get(tabId) : undefined;
		const status = frame.status as AutopilotStatus | undefined;
		if (!tabId || !status?.active) return frame;
		if (!run) {
			const recent = withRecentCycles(status);
			return recent === status ? frame : { ...frame, status: recent };
		}
		this.#tell("status", { tab: tabId, status });
		return { ...frame, status: withRecentCycles(this.#overlaid(run, status)) };
	}

	/** The bridge's cycle end, stop request and settled frames. */
	frame(sidecar: object, frame: Record<string, unknown>): void {
		const tabId = this.#tabOf.get(sidecar);
		if (!tabId) return;
		if (
			frame.type === "autopilot_cycle_end" ||
			frame.type === "autopilot_nudge" ||
			frame.type === "autopilot_stop_requested" ||
			frame.type === "autopilot_settled"
		) {
			this.#tell("frame", { tab: tabId, frame });
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
		const call = ++this.#callSeq;
		this.#calls.set(call, { win, sidecar });
		try {
			const answer = await this.#ask<CommandAnswer>("command", {
				call,
				tab: tabId,
				command,
				source: { device: Boolean(sidecar.device), cwd: sidecar.cwd },
				today: this.#deps.today?.() ?? localDate(new Date()),
				// What the person chose is dated by main's clock, as a cycle's start it is compared with.
				now: Date.now(),
			});
			if (!answer.ok) {
				return {
					id,
					type: "response",
					command: command.type,
					success: false,
					error: answer.error,
					...(answer.code ? { code: answer.code } : {}),
				} as RpcResponse;
			}
			const allCycles = command.type === "get_autopilot" && command.allCycles === true;
			const run = answer.overlay ? this.#mirror.get(answer.tabId ?? tabId) : undefined;
			const status = run ? this.#overlaid(run, answer.status) : answer.status;
			const shown = allCycles ? status : withRecentCycles(status);
			const data = answer.tabId === undefined ? shown : { ...shown, tabId: answer.tabId };
			return { id, type: "response", command: command.type, success: true, data } as RpcResponse;
		} catch (error) {
			return {
				id,
				type: "response",
				command: command.type,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			} as RpcResponse;
		} finally {
			this.#calls.delete(call);
		}
	}

	/**
	 * `get_autopilot`: a run's status with its newest cycles (`allCycles`: every one), or for any other tab what the start
	 * sheet needs.
	 */
	async status(sidecar: SidecarLike, tabId: string, allCycles = false): Promise<AutopilotStatus> {
		const response = await this.handleCommand(
			{} as ClientWindow,
			sidecar,
			tabId,
			{ type: "get_autopilot", ...(allCycles ? { allCycles } : {}) },
			undefined,
		);
		if (!response.success) throw new Error(response.error);
		return response.data as AutopilotStatus;
	}

	// ----------------------------------------------------------------------------------------
	// Stop, abort, resume
	// ----------------------------------------------------------------------------------------

	/** ■ (`STOP_COMMANDS` in ipc.ts): the running children stop with the parent; the run shows paused. */
	async aborted(tabId: string): Promise<void> {
		await this.#ask("aborted", { tab: tabId });
	}

	/** DeskTools: a stopping run opens and sends nothing new. */
	isStopping(callerTabId: string): boolean {
		return this.#mirror.get(callerTabId)?.stopping === true;
	}

	/** The worktree of the run `tabId` is, or whose child it is; undefined for any other tab. */
	runRootOf(tabId: string): string | undefined {
		const parent = this.#childRuns.get(tabId)?.parentTab ?? tabId;
		return this.#mirror.get(parent)?.root;
	}

	/**
	 * The tab is a run's own: a turn of it that a provider's limit ended waits in the run (its quota wait), so TurnResume
	 * arms no wait of its own beside it.
	 */
	holdsLimitWait(tabId: string): boolean {
		return this.#mirror.has(tabId);
	}

	/**
	 * TurnResume's goal resume after a relaunch (`ResumeDeps.resumeGoal`): an autopilot run is armed again first
	 * (overrides, tools and guard before the goal), any other tab gets stock's own resume.
	 */
	async resumeGoal(tabId: string): Promise<void> {
		const answer = await this.#ask<{ ok: true } | { ok: false; error: string }>("resumeGoal", { tab: tabId });
		if (!answer.ok) throw new Error(answer.error);
	}

	/**
	 * TurnResume finished a tab's launch continuation. A run it did not resume goes on all the same: the journal says
	 * `running`, whatever the restore read from stock's journal of the cut. Only the user's Stop on the "Continuing"
	 * toast leaves it paused.
	 */
	resumeSettled(tabId: string, outcome: GoalSettlement): void {
		this.#tell("resumeSettled", { tab: tabId, outcome });
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
		const answer = await this.#ask<{ ok: true } | { ok: false; error: string }>("beforeFirstPrompt", { child });
		if (!answer.ok) throw new Error(answer.error);
	}

	/** Resolves when every queued cycle-end/stop task and every background step of every run has finished (tests, quit). */
	async idle(): Promise<void> {
		await this.#ask("idle", {});
	}

	/** Closes the port to the core: what it still asks of main fails, and nothing more reaches this client. */
	dispose(): void {
		this.#port.close();
	}

	// ----------------------------------------------------------------------------------------
	// What the core reads of main
	// ----------------------------------------------------------------------------------------

	/** The approver's view of a tab: its run, or the run its parent runs (a child). */
	#approverRun(tabId: string): ApproverRun | undefined {
		const run = this.#mirror.get(tabId);
		if (run) {
			return {
				role: "parent",
				root: run.root,
				ship: run.policy,
				oneShotRelease: run.oneShotRelease,
				defaultBranch: run.baseBranch,
			};
		}
		const child = this.#childRuns.get(tabId);
		const parent = child ? this.#mirror.get(child.parentTab) : undefined;
		if (!child || !parent) return undefined;
		return {
			role: "child",
			root: child.root,
			ship: DEFAULT_SHIP_POLICY,
			oneShotRelease: false,
			defaultBranch: parent.baseBranch,
		};
	}

	#overlaid(run: RunMirror, status: AutopilotStatus): AutopilotStatus {
		const ship: AutopilotShipState = {
			...(status.ship ?? { policy: run.policy, queue: [] }),
			queue: run.queue.map(item => ({ ...item })),
			...(run.releaseProcedure ? { releaseProcedure: run.releaseProcedure } : {}),
			...(run.releaseBlocked && !run.releaseProcedure ? { releaseBlocked: run.releaseBlocked } : {}),
			...(run.landing ? { landing: run.landing } : {}),
			...(run.endAfterShip ? { endAfterShip: true as const } : {}),
		};
		const children: AutopilotChildLive[] = run.children.map(child => ({
			tabId: child.tabId,
			...(child.area ? { area: child.area } : {}),
			...(child.branch ? { branch: child.branch } : {}),
			status: this.#deps.pool.tabFacts(child.tabId)?.busy ? "running" : "done",
		}));
		return { ...status, ship, children, ...(run.stalls.length > 0 ? { stalls: run.stalls } : {}) };
	}

	#log(message: string): void {
		(this.#deps.log ?? ((text: string) => console.warn(`[autopilot] ${text}`)))(message);
	}

	/** The omp of a tab: its client, or why there is none. */
	#client(tab: string): NonNullable<SidecarLike["rpcClient"]> {
		const client = this.#deps.pool.sidecarOf(tab)?.rpcClient;
		if (!client) throw new Error("That session's process is gone.");
		return client;
	}

	/** A start's wait for its new tab's omp: no deadline, ended by the core. */
	#readyWait(tab: string): Promise<void> {
		const sidecar = this.#deps.pool.sidecarOf(tab);
		if (!sidecar) return Promise.reject(new Error("The Autopilot tab is gone."));
		if (sidecar.status === "ready") return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const listener = (payload: { status: string }) => {
			if (payload.status === "ready") finish(null);
			else if (payload.status === "error" || payload.status === "exited")
				finish(new Error("The Autopilot session failed to start."));
		};
		const finish = (error: Error | null) => {
			sidecar.off("status", listener);
			this.#readyCancels.delete(tab);
			if (error) reject(error);
			else resolve();
		};
		this.#readyCancels.set(tab, () => finish(new Error("The wait was ended.")));
		sidecar.on("status", listener);
		// A tab nobody has shown yet may still be asleep.
		if (sidecar.status === "asleep") sidecar.start();
		return promise;
	}

	#handlers() {
		const deps = this.#deps;
		const call = (id: number) => {
			const held = this.#calls.get(id);
			if (!held) throw new Error("That command is over.");
			return held;
		};
		return {
			gitRunner: () => gitRunner(),
			stock: ({ tab, command }: { tab: string; command: RpcCommand }) => this.#client(tab).command(command),
			bridge: ({
				tab,
				method,
				params,
				timeoutMs,
			}: {
				tab: string;
				method: string;
				params: unknown;
				timeoutMs?: number;
			}) =>
				this.#client(tab).command({ type: "autopilot_bridge", method, params } as unknown as RpcCommand, timeoutMs),
			facts: ({ tab }: { tab: string }) => deps.pool.tabFacts(tab),
			sidecar: ({ tab }: { tab: string }) => {
				const sidecar = deps.pool.sidecarOf(tab);
				return sidecar ? { cwd: sidecar.cwd, status: sidecar.status, device: Boolean(sidecar.device) } : null;
			},
			ready: ({ tab }: { tab: string }) => this.#readyWait(tab),
			readyCancel: ({ tab }: { tab: string }) => this.#readyCancels.get(tab)?.(),
			release: ({ tab }: { tab: string }) => deps.pool.releaseTabWhenExited(tab),
			noteStopped: ({ tab }: { tab: string }) => deps.pool.noteStopped(tab),
			turnStop: (stop: Parameters<typeof recordTurnStop>[0]) => recordTurnStop(stop),
			answer: ({ id, tab, response }: { id: string; tab: string; response: object }) =>
				deps.pool.routeSideChannel(id, response, tab),
			dispatch: ({
				call: id,
				tab,
				command,
				timeoutMs,
			}: {
				call: number;
				tab: string;
				command: RpcCommand;
				timeoutMs?: number;
			}) => {
				const { win, sidecar } = call(id);
				return deps.dispatch(win, sidecar, tab, command, timeoutMs);
			},
			spawnTab: ({ call: id, payload }: { call: number; payload: IpcSpawnTabPayload }) =>
				deps.spawnTab(call(id).win, payload),
			text: ({ key, params }: { key: MainTextKey; params?: Record<string, string | number> }) =>
				deps.text(key, params),
			releaseProcedure: ({ root }: { root: string }) =>
				(deps.detectRelease ?? detectReleaseProcedure)(root).catch(() => null),
			prText: ({ branch, cycles }: { branch: string; cycles: AutopilotStatus["cycles"] }) => ({
				title: autopilotLogTitle(branch, (cycles ?? []).length),
				body: formatAutopilotLog({ branch, cycles: cycles ?? [] }),
			}),
			prCreate: ({
				cwd,
				input,
			}: {
				cwd: string;
				input: { title: string; body: string; base?: string; head?: string; draft?: boolean };
			}) => (deps.prCreate ?? prCreate)(cwd, input),
			ghRun: ({ cwd, url }: { cwd: string; url: string }) => (deps.ghRun ?? ghRunStatus)(cwd, url),
			probeRepo: ({ root }: { root: string }) => deps.probeRepo?.(root),
			prepareWorktree: ({ primary, tree }: { primary: string; tree: string }) => prepareWorktree(primary, tree),
			landShell: ({ command }: { command: string }) => landShell(command),
			clearQueue: ({ tab }: { tab: string }) => this.#control?.clearQueue(tab),
			quotaWait: ({ reports, provider, now }: { reports: UsageReport[]; provider: string | null; now: number }) =>
				quotaWaitUntil(reports, provider ?? undefined, now),
			relaunch: ({ tab }: { tab: string }) => deps.relaunchContinuation(tab),
			notify: ({ tab, notice }: { tab: string; notice: AutopilotNotice }) => deps.notify(tab, notice),
			runEnded: ({ root }: { root: string }) => deps.runEnded?.(root),
			log: ({ message }: { message: string }) => this.#log(message),
			runLog: ({ message, details }: { message: string; details: Record<string, string | number | boolean> }) =>
				deps.runLog?.(message, details),
			mirror: (event: MirrorEvent) => {
				if ("gone" in event) this.#mirror.delete(event.tab);
				else this.#mirror.set(event.tab, event);
			},
			childRun: ({ tab, run }: { tab: string; run: { parentTab: string; root: string } | null }) => {
				if (run) this.#childRuns.set(tab, run);
				else this.#childRuns.delete(tab);
			},
		};
	}
}
