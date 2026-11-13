/**
 * The OMPdesk control tools' seam to the app (`AgentControlHost` of `service.ts`): the sidecar pool, the RPC
 * dispatcher `ipc.ts` already runs for every renderer command, the tab spawn path, the window's notifications and
 * views. `ipc.ts` constructs it once and routes each control host-tool call to `run`.
 *
 * A call names its caller by tab; the window that tab belongs to is remembered per call (`bindCaller`), because a
 * wait outlives the executor's stack frame and the tab list belongs to that window.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import type { AutopilotAction, AutopilotStatus } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import {
	AGENT_CARD_PREFIX,
	AGENT_CLOSED_CHILDREN_PREF,
	AGENT_CONTROL_APP,
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_FULL_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
	AGENT_CONTROL_REVIEW,
	AGENT_CONTROL_VIEW,
	AGENT_HIDDEN_PREFS_KEY,
	AGENT_SCHEDULE_PREFIX,
	type AgentControlToolName,
	type AgentControlViewEvent,
	type AgentReviewEvent,
	type AgentReviewResult,
	agentControlApproveEnabled,
	agentControlEnabled,
	agentControlFullEnabled,
	agentControlManageEnabled,
	agentHiddenPaths,
	type ClosedChild,
	isAgentControlTool,
	MAX_CLOSED_CHILDREN,
	type PrivacyPane,
	parseClosedChildren,
	sidebarViewOf,
} from "../../shared/agent-control";
import type {
	HostView,
	IpcSpawnTabPayload,
	IpcSpawnTabResult,
	IpcTabInfo,
	IpcTabWorktree,
	SessionContentMatch,
	SessionInfo,
} from "../../shared/ipc-types";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { MAX_RPC_COMMAND_TIMEOUT_MS } from "../../shared/rpc-client";
import {
	type AgentMessage,
	BLOCKING_UI_METHODS,
	type ExtensionUIResponse,
	type ImageContent,
	isSignInRequest,
	type RpcCommand,
	type RpcResponse,
	type RpcWorktreeCreateResult,
	type TextContent,
} from "../../shared/rpc-types";
import type { Schedule } from "../../shared/schedules";
import type { SessionSummary, VersionedSummaries } from "../../shared/session-summary";
import type { FamilyEdits } from "../../shared/turn-edits";
import { deletedSessions } from "../deleted-sessions";
import { discardOpenedWorktree } from "../disk/saved-worktrees";
import { createWorktree, tablessWorktreeBridge, WORKTREE_COMMAND_BUDGETS_MS } from "../local/git/worktree";
import { describePreparation, MERGE_HOOKS_BUDGET_MS } from "../local/git/worktree-seed";
import {
	GIT_METHODS,
	GIT_REQUEST_TIMEOUT_MS,
	ScheduleCreatedSchema,
	SchedulesStateSchema,
	WorktreeCreateReply,
} from "../remote/app-protocol";
import { uploadToHost } from "../remote/host-upload";
import type { RunProcess, ScheduleService } from "../schedules";
import type { Pace } from "../session-pace";
import { SUPERVISOR_STOPPED_CODE } from "../setup/supervisor";
import type { SidecarPool, TabActivity } from "../sidecar-pool";
import type { SidecarLike } from "../sidecar-types";
import { recordTurnStop } from "../turn-stop-log";
import { type ClientWindow, isWebWindow } from "../web/client-window";
import type { FileEditReports } from "../web/file-edit-reports";
import { attachHere, type UploadStore } from "../web/uploads";
import { sessionOpenFolders } from "../worktree-orphans";
import {
	type BranchEvidence,
	type BranchFacts,
	branchEvidence,
	branchFacts,
	type LandingFacts,
	landingFacts,
	type MergeOutcome,
	mergeBranch,
	removeSafeWorktree,
	type WorktreeRef,
	type WorktreeRemoval,
} from "./branches";
import type { MailDelivery } from "./mail";
import {
	AgentControl,
	type AgentControlHost,
	type AutopilotSource,
	type ControlAsk,
	type ControlTab,
	type HostTab,
	type Landing,
	type MailAnswer,
	type OpenElsewhere,
	type OpenedChild,
	type ReleasedSession,
	type RuntimeTuning,
	type SchedulesHost,
	type SentAnswer,
	SessionFolderMissing,
	type SpawnRequest,
	type StoredWork,
	type Tombstones,
	type ToolOutcome,
	type Tuning,
} from "./service";

/** A confirmation card waits for the person this long. */
export const CARD_TIMEOUT_MS = 10 * 60_000;
const WORKTREE_PREFIX = "omp/agent/";
/** A receiver's bridge answers which messages its journal holds within this (a socket request, no omp command queue). */
const SENT_MARKS_TIMEOUT_MS = 8_000;

/** Every tombstone, by file and computer and by saved id (stock names a session file `<time>_<session id>.jsonl`). */
function tombstones(): Tombstones {
	const byPath: Tombstones["byPath"] = [];
	const byId: Tombstones["byId"] = {};
	for (const entry of deletedSessions().list()) {
		byPath.push(entry);
		const id = /_([^_/\\]+)\.jsonl$/.exec(entry.path)?.[1];
		if (id && byId[id] === undefined) byId[id] = entry.at;
	}
	return { byPath, byId };
}

/** What a session does now, by its summary (the one rows read); unknown before its omp is up. */
function summaryWork(summary: SessionSummary): StoredWork | undefined {
	if (summary.ask) return "waiting";
	if (summary.status === "running") return summary.settling ? "background" : "turn";
	return summary.status === "ready" ? "idle" : undefined;
}

export interface AgentControlHostDeps {
	pool: Pick<
		SidecarPool,
		| "tabsForWindow"
		| "tabFacts"
		| "pendingPlan"
		| "observeTabs"
		| "openRequests"
		| "routeSideChannel"
		| "sidecarOf"
		| "startTab"
		| "setTabTask"
		| "formerTabIds"
		| "setTabOpener"
		| "hasDraft"
		| "windowOfTab"
		| "windowsShowingTab"
		| "tabWindows"
		| "sessionOwner"
		| "whenTabExited"
	>;
	/** This computer's session index (stored sessions the control tools list, search and read). */
	sessions?: {
		list(): Promise<SessionInfo[]>;
		search(query: string, paths: string[]): Promise<SessionContentMatch[]>;
		read(sessionPath: string): Promise<AgentMessage[]>;
		pace?(sessionPath: string): Promise<Pace | undefined>;
	};
	/** The paired hosts this computer runs sessions on (Settings › Devices) and a request to one of them. */
	remote?: {
		hosts(): HostView[];
		request<T>(deviceId: string, method: string, params: unknown, timeoutMs?: number): Promise<T>;
	};
	/**
	 * The session summaries of this computer (no device) or of a paired host as this computer holds them: what every
	 * row shows, so a list line and a row cannot disagree. Null for a host offline or too old to send them.
	 */
	summaries?: (device?: string) => VersionedSummaries | null;
	/** The same dispatcher the renderer's RPC commands go through (local handlers, host link, quota). */
	dispatch: (
		win: ClientWindow,
		sidecar: SidecarLike,
		tabId: string,
		command: RpcCommand,
		timeoutMs?: number,
	) => Promise<RpcResponse>;
	spawnTab: (win: ClientWindow, payload: IpcSpawnTabPayload) => Promise<IpcSpawnTabResult | null>;
	/** `set`/`changed` persist a list main owns (closed opened sessions) and tell every window; absent where there is no store. */
	prefs: { get(key: string): unknown; set?(key: string, value: unknown): void; changed?(key: string): void };
	/** A paired host's display name for a deviceId. */
	deviceName: (deviceId: string) => string;
	/** An OS notification; a click opens the tab. */
	notify: (win: ClientWindow, tabId: string, title: string, body: string) => void;
	/** Close a session's tab and delete its saved file (the sidebar's delete). */
	deleteSession: (sessionPath: string, device: string | undefined) => Promise<void>;
	text: AgentControlHost["text"];
	/** How often opened sessions are looked at for closing, in the core's runtime; 0 turns the timer off (default 10 s). */
	sweepMs?: number;
	/** A parent's review list went to its windows: a paired device viewing that session hears it too. */
	reviewSent?: (callerTabId: string, review: AgentReviewResult) => void;
	/** The waits of the core's service and runtime, in ms (a test shortens them; absent: the defaults). */
	tuning?: Tuning;
	runtimeTuning?: RuntimeTuning;
	/** Where accepted reports wait for their receiver's journal (`mail-outbox`); absent: kept in memory only. */
	mailOutboxFile?: string | null;
	/** Where the bytes of the attachments an outbox entry still owes are kept, by content; absent: in memory only. */
	attachmentsDir?: string | null;
	/** This computer's upload folder (`web/uploads.ts`): where a file sent to a session on this computer lands. */
	uploads?: Pick<UploadStore, "store">;
	/** Where sent messages wait for their receiver's journal (`send-outbox`); absent: kept in memory only. */
	sendOutboxFile?: string | null;
	/** Where the control-tool calls that change something are recorded (`call-journal`); absent: in memory only. */
	callJournalFile?: string | null;
	/** Where what became of each session an id named is kept (`session-fates`); absent: in memory only. */
	sessionFatesFile?: string | null;
	/** Where cleanups refused while the person was in the session wait (`pending-cleanups`); absent: in memory only. */
	pendingCleanupsFile?: string | null;
	/** The app is quitting: the tabs its windows release now are not closed sessions, and the next launch restores them. */
	quitting?: () => boolean;
	/** The sessions sharing a tab's checkout or repository on this computer (src/main/checkout-peers.ts). */
	checkoutPeers?: (tabId: string) => readonly string[];
	/** Autopilot's hooks (src/main/autopilot*.ts). */
	isStopping?: (callerTabId: string) => boolean;
	beforeFirstPrompt?: (child: OpenedChild) => Promise<void>;
	/** A run tab Autopilot coordinates (`Autopilot.runRootOf`): it ends with its run, never by the opened-session rules. */
	isAutopilotRun?: (tabId: string) => boolean;
	/** Autopilot's coordinator (`Autopilot.handleCommand`); absent where there is none. */
	autopilot?: {
		command: (
			win: ClientWindow,
			sidecar: SidecarLike,
			tabId: string,
			command: { type: "get_autopilot" } | ({ type: "set_autopilot" } & AutopilotAction),
		) => Promise<RpcResponse>;
	};
	/** What paired web pages last reported about unsaved Files edits in their tabs (ipc.ts `FILE_EDIT_REPORT`). */
	fileEdits: Pick<FileEditReports, "edits" | "onReport">;
	/**
	 * Close a tab of `win` the way the window's own close does (ipc.ts `closeWindowTab`) and tell that window it is
	 * gone. Only for a paired web page's window: a desktop window closes its own tab when asked (`AGENT_CONTROL_VIEW`).
	 * `stillReleasable` is asked again after the release's awaits, right before it lets the tab go.
	 */
	releaseTab: (win: ClientWindow, tabId: string, stillReleasable: () => boolean) => Promise<boolean>;
	/** Settings › Schedules (`ScheduleService`); absent or null where there is none. */
	schedules?: () => Pick<ScheduleService, "command" | "create"> | null;
	/** The app's own handlers `ompdesk_app` goes through (src/main/ipc.ts): the `IpcRegistry` for the window, `PREFS_SET`, the language. */
	app?: {
		invoke: (win: ClientWindow, channel: string, args: readonly unknown[]) => Promise<unknown>;
		fire: (win: ClientWindow, channel: string, args: readonly unknown[]) => void;
		localize: (en: string, ko: string) => string;
		/** Open a macOS Privacy & Security pane in System Settings; rejects elsewhere. */
		openPrivacyPane: (pane: PrivacyPane) => Promise<void>;
	};
	/**
	 * The window a caller outside OMPdesk (the control socket, src/main/control-socket) acts through: the sessions it
	 * opens are tabs of it. Null while the app has no window.
	 */
	outsideWindow?: () => ClientWindow | null;
	/** A confirmation card for a caller outside OMPdesk, which has no session of its own to show one in. */
	confirmOutside?: (win: ClientWindow, caller: OutsideCaller, title: string, message: string) => Promise<boolean>;
}

function askOf(request: ControlAsk["request"]): boolean {
	return BLOCKING_UI_METHODS[request.method] === true && !isSignInRequest(request);
}

/** What a worktree for a new session is made from (`worktree_create`'s fields). */
type WorktreeInput = { name: string; baseCwd: string; baseRef: string; branchPrefix: string };

/** The binding `host.git.*` takes: exactly the checkout, its branch and its parent (never the tab's own name). */
function gitRef(worktree: WorktreeRef): WorktreeRef {
	return { path: worktree.path, branch: worktree.branch, baseCwd: worktree.baseCwd };
}

/** `omp/agent/<name>` from a branch the agent chose: the prefix (through the last `/`) and the name. */
export function splitBranch(branch: string | undefined, slug: string): { branchPrefix: string; name: string } {
	if (!branch) return { branchPrefix: WORKTREE_PREFIX, name: slug };
	const at = branch.lastIndexOf("/");
	return at < 0
		? { branchPrefix: "", name: branch }
		: { branchPrefix: branch.slice(0, at + 1), name: branch.slice(at + 1) };
}

/** Every outside caller's id starts with this; no tab id does. */
const OUTSIDE_PREFIX = "outside:";

function isOutside(id: string): boolean {
	return id.startsWith(OUTSIDE_PREFIX);
}

/**
 * A process outside OMPdesk driving it over the control socket (a terminal omp, a script, another agent CLI). It acts
 * as an agent with no tab: the same tools, rules and cards as an agent in a session, never fewer checks.
 */
export interface OutsideCaller {
	/**
	 * `outside:<name>#<connection>`: one per socket connection, so another process that claims the same name never
	 * shares the sessions it opened or the reports addressed to it.
	 */
	id: string;
	/** The name the process gave itself (`OMPDESK_CALLER`): self-declared, never an identity. */
	name: string;
	/** What cards and messages call it. */
	title: string;
	/** Where a session it opens without a folder starts. */
	cwd: string;
}

export class AgentControlRuntime {
	readonly #deps: AgentControlHostDeps;
	readonly #windows = new Map<string, ClientWindow>();
	/** Who opened a tab and for what (Autopilot's tag). */
	readonly #parents = new Map<string, { callerTabId: string; tag?: string }>();
	readonly control: AgentControl;
	/** Tabs a person sent a prompt of their own (`noteUserPrompt`): never closed by themselves. */
	readonly #userPrompted = new Set<string>();
	/** Run tabs `ompdesk_autopilot` started: they end with their run, not with the rules for opened sessions. */
	readonly #autopilotRuns = new Set<string>();
	/** Callers outside OMPdesk by id (`runOutside`), kept while the app runs: their sessions' provenance. */
	readonly #outside = new Map<string, OutsideCaller>();
	/** Whoever hears the reports addressed to an outside caller (the control socket's event stream). */
	readonly #outsideMail = new Set<(callerId: string, text: string) => void>();
	/** The card each outside caller shows now, if any: the next one waits for it. */
	readonly #outsideCards = new Map<string, Promise<void>>();
	/** The routines' wake-ups waiting for their turn, by run: how each ended is what the core tells (`wakeDone`). */
	readonly #wakes = new Map<string, (result: { code: number | null; error?: string }) => void>();

	constructor(deps: AgentControlHostDeps) {
		this.#deps = deps;
		this.control = new AgentControl(this.#host(), {
			tuning: deps.tuning,
			runtime: deps.runtimeTuning,
			files: {
				fates: deps.sessionFatesFile ?? null,
				cleanups: deps.pendingCleanupsFile ?? null,
				calls: deps.callJournalFile ?? null,
				sendOutbox: deps.sendOutboxFile ?? null,
				mailOutbox: deps.mailOutboxFile ?? null,
				attachments: deps.attachmentsDir ?? null,
			},
		});
		// Every tab activity goes to the core's runtime, which decides what it means (the sweep of the opened sessions,
		// the review board, a child's question for its opener); main adds what only it knows at that moment.
		deps.pool.observeTabs(activity => this.#activity(activity));
		// A paired page's changed word about its Files editor (its unsaved edits saved or dropped) lets a child it held
		// back close now, not at the next timer tick.
		deps.fileEdits.onReport(() => void this.control.runtime.sweepOpeners().catch(() => undefined));
	}

	/** The tab Autopilot (or anyone) opened this one for, if the control tools opened it. */
	parentOf(tabId: string): { callerTabId: string; tag?: string } | undefined {
		return this.#parents.get(tabId);
	}

	/** One pool activity, to the core's runtime with the opener, the card rule and the released session main knows. */
	#activity(activity: TabActivity): void {
		const { pool } = this.#deps;
		const parent = this.#openerOf(activity.tabId);
		// A child's question card tells its opener (local and paired-device children alike); an Autopilot run's
		// children are answered by its approver, and the run reads them itself.
		const announce =
			activity.type === "ask" &&
			parent !== undefined &&
			this.#parents.get(activity.tabId)?.tag === undefined &&
			!this.#autopilotRuns.has(parent) &&
			!this.#deps.isAutopilotRun?.(parent);
		let session: ReleasedSession | undefined;
		if (activity.type === "released") {
			const held = this.#deps.quitting?.() ? undefined : activity.session;
			const openerWin = parent ? this.#win(parent) : undefined;
			const opener =
				parent && openerWin && !openerWin.isDestroyed()
					? pool.tabsForWindow(openerWin).find(tab => tab.tabId === parent)?.sessionPath
					: undefined;
			if (held)
				session = {
					...held,
					...(!held.device && this.#hiddenPaths().has(held.path) ? { hidden: true } : {}),
					...(opener ? { openedBySession: opener } : {}),
				};
		}
		void this.control.runtime
			.activity({
				type: activity.type,
				tabId: activity.tabId,
				...(activity.type === "ask" ? { requestId: activity.requestId } : {}),
				...(activity.type === "idle" && activity.outcome ? { outcome: activity.outcome } : {}),
				...(parent ? { parent } : {}),
				...(announce ? { announce: true } : {}),
				...(session ? { session } : {}),
			})
			.catch(() => undefined);
		if (activity.type === "released") {
			this.#windows.delete(activity.tabId);
			this.#parents.delete(activity.tabId);
			this.#userPrompted.delete(activity.tabId);
		}
	}

	/**
	 * A session's own wake-up came due (`ompdesk_schedule` with `target: "self"`, run by `ScheduleService`): the
	 * schedule's prompt reaches that session as a mail that starts a turn, through the outbox like every report (an omp
	 * that misses it gets it again). A session no tab here holds is opened in a background tab of the front window, an
	 * asleep one is started; a session whose file is gone, or with no window to open it in, fails the run with the
	 * reason. Delivered, the run follows the turn it started (or the one it joined): it ends when that turn ends, with
	 * the turn's error if it failed; a tab closed meanwhile, or no turn within the core's wake wait, fails it. `stop()`
	 * stops that turn. The core keeps the mail and follows the turn; this reaches the session and reports the end.
	 */
	async wakeSession(schedule: Schedule, runId: string): Promise<RunProcess> {
		if (schedule.wakeSession === undefined) throw new Error("This schedule wakes no session");
		const sessionPath = schedule.wakeSession;
		if (
			!(await stat(sessionPath).then(
				entry => entry.isFile(),
				() => false,
			))
		)
			throw new Error(`The session to wake is gone (${sessionPath})`);
		const { promise: done, resolve } = Promise.withResolvers<{ code: number | null; error?: string }>();
		this.#wakes.set(runId, resolve);
		try {
			await this.control.runtime.wake({
				runId,
				sessionPath,
				fromTitle: schedule.name.replace(AGENT_SCHEDULE_PREFIX, "").trim() || "Scheduled wake",
				text: schedule.prompt,
				stoppedCode: SUPERVISOR_STOPPED_CODE,
			});
		} catch (error) {
			// Nothing woke: the run fails, and the mail is not left to turn up in this session later.
			this.#wakes.delete(runId);
			throw error;
		}
		return {
			done,
			stop: () => {
				void this.control.runtime.wakeStop(runId).then(
					({ holder, started }) => {
						if (holder && started) {
							recordTurnStop({ command: "abort", tab: holder, by: "schedule", surface: "routine-stop" });
							void this.#hostCommand(holder, { type: "abort" }).catch(() => undefined);
						}
					},
					() => resolve({ code: SUPERVISOR_STOPPED_CODE }),
				);
			},
		};
	}

	/**
	 * The tab holding `sessionPath` (an asleep one is started), or null after the session was opened in a background
	 * tab of the front window. Rejects when there is no window to open it in, or the open fails.
	 */
	async #reach(sessionPath: string): Promise<string | null> {
		const { pool } = this.#deps;
		const owner = pool.sessionOwner(sessionPath);
		const ownerWin = owner ? this.#win(owner.tabId) : undefined;
		const tab = ownerWin ? pool.tabsForWindow(ownerWin).find(entry => entry.tabId === owner?.tabId) : undefined;
		if (tab?.status === "asleep") void pool.startTab(tab.tabId);
		if (tab) return tab.tabId;
		const win = this.#deps.outsideWindow?.();
		if (!win) throw new Error("No window to open the session in.");
		await this.#deps.spawnTab(win, { sessionPath });
		return null;
	}

	/** A person (not an agent) sent `tabId` a prompt: its session never closes by itself again. */
	noteUserPrompt(tabId: string): void {
		if (!this.#openerOf(tabId)) return;
		this.#userPrompted.add(tabId);
		this.control.changed();
	}

	/** The person typed a prompt to `tabId` in a window, on the phone page or on a paired device (main's word, not the text). */
	personTyped(tabId: string): void {
		void this.control.personTyped(tabId).catch(() => undefined);
	}

	/**
	 * The tab that opened `tabId`: the one this launch saw open it, else the opener the pool kept across a relaunch
	 * (its tab id, or, as tab ids are new after a relaunch, the tab now holding the opener's session file).
	 */
	#openerOf(tabId: string): string | undefined {
		const known = this.#parents.get(tabId)?.callerTabId;
		if (known) return known;
		const win = this.#win(tabId);
		const info = win ? this.#deps.pool.tabsForWindow(win).find(entry => entry.tabId === tabId) : undefined;
		return info ? this.#restoredOpener(info) : undefined;
	}

	#restoredOpener(info: IpcTabInfo): string | undefined {
		const { pool } = this.#deps;
		if (info.openedBy && pool.sidecarOf(info.openedBy)) return info.openedBy;
		if (!info.openedBySession) return undefined;
		return pool.sessionOwner(info.openedBySession)?.tabId ?? undefined;
	}

	/**
	 * Opened by the control tools' `ompdesk_session_open` (not Autopilot's child or run, not the person). After a
	 * relaunch only the pool knows the opener: an Autopilot child has none there (it nests under its run), and a run
	 * an agent started is told by the coordinator.
	 */
	#autoClosable(info: IpcTabInfo): boolean {
		if (this.#autopilotRuns.has(info.tabId) || this.#deps.isAutopilotRun?.(info.tabId)) return false;
		const parent = this.#parents.get(info.tabId);
		return parent ? parent.tag === undefined : this.#restoredOpener(info) !== undefined;
	}

	/**
	 * A running child's step and cost move inside its turn, with no busy or idle edge to push them. A work board that
	 * shows the opener's children asks for them (`agent_control_review {live: true}`, only while it is mounted in a
	 * visible window: renderer `WorkBoardOpened.tsx` `useLiveReview`); the core reads only the running children whose
	 * omp sent a step since, and pushes the list when they moved.
	 */
	async liveReview(callerTabId: string): Promise<void> {
		await this.control.runtime.liveReview(callerTabId);
	}

	/** The closed-children list main keeps (`ClosedChild`), newest last; the child's own record is replaced. */
	#recordClosed(child: ClosedChild): void {
		const { prefs } = this.#deps;
		if (!prefs.set) return;
		const rows = parseClosedChildren(prefs.get(AGENT_CLOSED_CHILDREN_PREF)).filter(row => row.path !== child.path);
		rows.push(child);
		this.#setClosedChildren(rows.slice(-MAX_CLOSED_CHILDREN));
	}

	/** Writes the list and tells every window and the service. */
	#setClosedChildren(rows: ClosedChild[]): void {
		const { prefs } = this.#deps;
		if (!prefs.set) return;
		prefs.set(AGENT_CLOSED_CHILDREN_PREF, rows);
		prefs.changed?.(AGENT_CLOSED_CHILDREN_PREF);
		this.control.changed();
	}

	/**
	 * Drop the closed record of every deleted session (`deleted-sessions.ts`): a deleted session never comes back, and
	 * its record kept it in its opener's family. Run on every delete and once at startup, for records a delete before
	 * this rule left behind. The core decides (it holds the fates); the rest of the list comes back to `#setClosedChildren`.
	 */
	forgetDeleted(): Promise<void> {
		if (!this.#deps.prefs.set) return Promise.resolve();
		return this.control.runtime.forgetDeleted().catch(() => undefined);
	}

	/** Execute one control host-tool call made by `callerTabId`'s main agent; `call` is the host tool call (service.ts `run`). */
	async run(
		win: ClientWindow,
		callerTabId: string,
		tool: AgentControlToolName,
		args: unknown,
		call?: { id: string; resent?: boolean },
	): Promise<ToolOutcome> {
		this.#windows.set(callerTabId, win);
		const outcome = await this.control.run(callerTabId, tool, args, call);
		if (
			tool === "ompdesk_session_open" ||
			tool === "ompdesk_merge" ||
			tool === "ompdesk_session_stop" ||
			tool === "ompdesk_autopilot"
		)
			void this.control.runtime.afterRun(callerTabId).catch(() => undefined);
		return outcome;
	}

	/** The host took the result of host call `callId`: its record may be forgotten in time (`CallJournal.acknowledge`). */
	acknowledge(callId: string): void {
		void this.control.runtime.acknowledge(callId).catch(() => undefined);
	}

	/**
	 * One control tool call by a process outside OMPdesk (the control socket): the same service, rules and cards as
	 * `run`, with the caller standing in for a tab (`outsideCaller`). It acts through the app's front window.
	 */
	async runOutside(caller: OutsideCaller, tool: string, args: unknown): Promise<ToolOutcome> {
		if (!isAgentControlTool(tool)) return { text: `There is no OMPdesk control tool "${tool}".`, isError: true };
		const entered = this.#enterOutside(caller);
		if (entered) return { text: entered, isError: true };
		return this.control.run(caller.id, tool, args);
	}

	/** The open session `name` names for an outside caller, by the tools' own name rules (hidden refused). */
	async resolveOutside(caller: OutsideCaller, name: string): Promise<ControlTab> {
		const entered = this.#enterOutside(caller);
		if (entered) throw new Error(entered);
		return this.control.openTarget(caller.id, name);
	}

	/** Every open tab of the app as the tools see it, from no session's window (the control socket's waits). */
	controlTabs(): ControlTab[] {
		return this.#hostTabs().map(({ window: _window, ...tab }) => tab);
	}

	onOutsideMail(listener: (callerId: string, text: string) => void): () => void {
		this.#outsideMail.add(listener);
		return () => this.#outsideMail.delete(listener);
	}

	/** The caller's connection closed: it no longer acts or hears; the sessions it opened stay open. */
	releaseOutside(caller: OutsideCaller): void {
		this.#outside.delete(caller.id);
		this.#windows.delete(caller.id);
		this.#outsideCards.delete(caller.id);
		this.control.changed();
	}

	/** Bind an outside caller to the front window; the refusal's text when there is none. */
	#enterOutside(caller: OutsideCaller): string | null {
		const win = this.#deps.outsideWindow?.();
		if (!win || win.isDestroyed())
			return "OMPdesk has no window open. Open one (click its Dock or tray icon) and try again.";
		this.#outside.set(caller.id, caller);
		this.#windows.set(caller.id, win);
		return null;
	}

	/** The work board's opened-session rows: the list of sessions this one opened (read-only; the agent lands them with tools). */
	async review(win: ClientWindow, callerTabId: string): Promise<AgentReviewResult> {
		// A window viewing the tab (a phone) asks too; the owner stays the one its tools answer through.
		if (!this.#deps.pool.windowOfTab(callerTabId)) this.#windows.set(callerTabId, win);
		return this.control.runtime.review(callerTabId);
	}

	/** What the sessions this one opened changed (the work board's "Changed" row; read-only). */
	async familyEdits(win: ClientWindow, callerTabId: string, since?: number): Promise<FamilyEdits> {
		if (!this.#deps.pool.windowOfTab(callerTabId)) this.#windows.set(callerTabId, win);
		return this.control.runtime.familyEdits(callerTabId, since);
	}

	/**
	 * To every window showing the opener: its owner and a phone viewing it. A viewer's tab list never holds the
	 * children (they are tabs of the window that opened them), so these rows are all it knows of them: without
	 * them its work strip said nothing while the children worked.
	 */
	#reviewSent(callerTabId: string, review: AgentReviewResult): void {
		const showing = this.#deps.pool.windowsShowingTab(callerTabId);
		const own = this.#win(callerTabId);
		for (const win of own && !showing.includes(own) ? [own, ...showing] : showing)
			if (!win.isDestroyed())
				win.webContents.send(AGENT_CONTROL_REVIEW, { tabId: callerTabId, ...review } satisfies AgentReviewEvent);
		this.#deps.reviewSent?.(callerTabId, review);
	}

	/** The window a tab's calls go through: the one remembered for it, else the window that owns it (any window). */
	#win(tabId: string): ClientWindow | undefined {
		return this.#windows.get(tabId) ?? this.#deps.pool.windowOfTab(tabId) ?? undefined;
	}

	#sidecar(tabId: string): SidecarLike {
		const sidecar = this.#deps.pool.sidecarOf(tabId);
		if (!sidecar) throw new Error("That session's process is gone.");
		return sidecar;
	}

	#hiddenPaths(): Set<string> {
		return agentHiddenPaths(this.#deps.prefs.get(AGENT_HIDDEN_PREFS_KEY));
	}

	/** Every open tab of the app once, in the pool's order, with the window it is in (any window). */
	#hostTabs(): HostTab[] {
		const { pool } = this.#deps;
		const hidden = this.#hiddenPaths();
		const seen = new Set<string>();
		const tabs: HostTab[] = [];
		for (const win of pool.tabWindows()) {
			if (win.isDestroyed()) continue;
			const open = pool.openRequests(win);
			for (const info of pool.tabsForWindow(win)) {
				if (seen.has(info.tabId)) continue;
				seen.add(info.tabId);
				const asks = open
					.filter(entry => entry.tabId === info.tabId && !entry.signIn && askOf(entry.request))
					.map(entry => ({ id: entry.request.id, request: entry.request }));
				tabs.push({ ...this.#controlTab(info, asks, hidden), window: String(win.webContents.id) });
			}
		}
		return tabs;
	}

	#controlTab(info: IpcTabInfo, asks: ControlAsk[], hidden: Set<string>): ControlTab {
		const plan = this.#deps.pool.pendingPlan(info.tabId);
		const autoClosable = this.#autoClosable(info);
		const formerIds = this.#deps.pool.formerTabIds(info.tabId);
		const facts = this.#deps.pool.tabFacts(info.tabId);
		const owner = this.#deps.pool.windowOfTab(info.tabId);
		// A paired web page's tab: what its page last said about unsaved Files edits in it (never assumed clean).
		const webEdits =
			owner && isWebWindow(owner.webContents.id)
				? this.#deps.fileEdits.edits(owner.webContents.id, info.tabId)
				: undefined;
		return {
			tabId: info.tabId,
			// Until stock names an opened session, it reads as the work it was opened for (`IpcTabInfo.task`).
			title: info.title || info.task || "",
			cwd: info.cwd,
			...(info.device ? { device: info.device, deviceName: this.#deps.deviceName(info.device) } : {}),
			status: info.status,
			...(this.#deps.pool.sidecarOf(info.tabId)?.statusPayload?.sessionHeld ? { sessionHeld: true } : {}),
			...(info.message && (info.status === "error" || info.status === "exited") ? { failure: info.message } : {}),
			...(info.status === "starting" && (info.queued || info.slow)
				? { startWait: info.queued ? ("queued" as const) : ("slow" as const) }
				: {}),
			busy: facts?.busy === true,
			...(info.resuming ? { resuming: true } : {}),
			asks,
			...(plan ? { plan } : {}),
			hidden: !info.device && typeof info.sessionPath === "string" && hidden.has(info.sessionPath),
			...(info.worktree ? { worktree: info.worktree } : {}),
			...(info.sessionPath ? { sessionPath: info.sessionPath } : {}),
			...(info.task ? { task: info.task } : {}),
			...(info.lastRun ? { lastRun: info.lastRun } : {}),
			autoClosable,
			...(autoClosable && !this.#parents.has(info.tabId) ? { restored: true } : {}),
			looked: info.active === true || info.visible === true || (info.viewerCount ?? 0) > 0,
			userTouched: this.#userPrompted.has(info.tabId) || this.#deps.pool.hasDraft(info.tabId),
			...(this.#deps.pool.hasDraft(info.tabId) ? { drafting: true } : {}),
			...(facts?.runningSince !== undefined ? { busySince: facts.runningSince } : {}),
			...(formerIds.length > 0 ? { formerIds } : {}),
			...(webEdits ? { webEdits } : {}),
		};
	}

	/** A paired host's folder as typed, or this computer's resolved against the caller's. */
	async #folder(caller: { cwd: string; device?: string }, folder: string | undefined): Promise<string> {
		if (!folder) return caller.cwd;
		if (caller.device) return /^([a-zA-Z]:[\\/]|\/)/.test(folder) ? folder : posix.join(caller.cwd, folder);
		const target = isAbsolute(folder) ? folder : resolve(caller.cwd, folder);
		const info = await stat(target).catch(() => null);
		if (!info?.isDirectory()) throw new Error(`"${target}" is not a folder on this computer.`);
		return target;
	}

	async #spawn(
		callerTabId: string,
		request: SpawnRequest,
	): Promise<{ tabId: string; worktree?: IpcTabWorktree; prepared?: string }> {
		const win = this.#win(callerTabId);
		if (!win) throw new Error("This session's window is gone.");
		// A caller outside OMPdesk runs on this computer and has no tab: its folder is where it was started.
		const outside = this.#outside.get(callerTabId);
		const caller = outside ? { cwd: outside.cwd, device: undefined } : this.#sidecar(callerTabId);
		// `device` absent: the caller's own machine; null: this computer; an id: that paired host.
		const device = request.device === undefined ? caller.device : (request.device ?? undefined);
		const elsewhere = device !== caller.device;
		// Another machine's folder is never resolved against the caller's: an absolute path, or that machine's default workspace.
		const cwd = request.sessionPath
			? undefined
			: elsewhere
				? request.folder && /^([a-zA-Z]:[\\/]|\/)/.test(request.folder)
					? request.folder
					: undefined
				: await this.#folder(caller, request.folder);
		if (elsewhere && request.folder && cwd === undefined)
			throw new Error(`On another device the folder must be absolute (got "${request.folder}").`);
		if (elsewhere && request.worktree && cwd === undefined)
			throw new Error(
				"A worktree on another device needs that device's repository: pass its absolute folder (the checkout to branch from).",
			);
		let worktree: IpcTabWorktree | undefined;
		let prepared: string | null = null;
		if (request.worktree && cwd !== undefined) {
			const slug = `agent-${Math.random().toString(36).slice(2, 8)}`;
			const { branchPrefix, name } = splitBranch(request.worktree.branch, slug);
			const input = { name, baseCwd: cwd, baseRef: request.worktree.base ?? "HEAD", branchPrefix } as const;
			// The worktree is made on the computer the new session runs on: the caller's own through its tab,
			// another one without a tab of the caller there.
			const made =
				elsewhere || outside
					? await this.#worktreeOn(device, input).catch((error: unknown) => {
							throw new Error(
								`Creating the worktree failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						})
					: await this.#worktreeThroughCaller(win, this.#sidecar(callerTabId), callerTabId, input);
			worktree = { name, branch: made.branch, baseCwd: made.baseCwd, path: made.path };
			prepared = describePreparation(made);
		}
		const target = worktree?.path ?? cwd;
		const result = await this.#deps.spawnTab(win, {
			...(target !== undefined ? { cwd: target } : {}),
			...(request.sessionPath ? { sessionPath: request.sessionPath } : {}),
			...(request.restoreSaved ? { restoreSaved: true as const } : {}),
			...(worktree ? { worktree } : {}),
			...(device ? { device } : {}),
			...(request.task ? { task: request.task } : {}),
		});
		if (!result?.tabId) {
			// The worktree made for a session that never started goes with it (git's own commands, never forced).
			if (worktree) {
				const made = worktree;
				await this.#git<WorktreeRemoval>(device, GIT_METHODS.discardWorktree, { worktree: gitRef(made) }, () =>
					discardOpenedWorktree(made, { openFolders: sessionOpenFolders }),
				).catch(() => null);
			}
			if (result?.refusal === "folder-missing")
				throw new SessionFolderMissing(result.folder ?? "", result.saved ?? null);
			throw new Error("The new session could not be started.");
		}
		this.#windows.set(result.tabId, win);
		// A view of a tab that holds the session elsewhere stays whoever's it was: no parent, no opener.
		if (request.join) return { tabId: result.tabId };
		this.#parents.set(result.tabId, { callerTabId, ...(request.tag ? { tag: request.tag } : {}) });
		// An Autopilot child already sits under its run (`tag`); a session the tool opens nests under its opener. An
		// outside caller has no tab to nest under: its sessions sit in the sidebar like the person's own.
		if (!request.tag && !outside) this.#deps.pool.setTabOpener(result.tabId, callerTabId);
		return { tabId: result.tabId, ...(worktree ? { worktree } : {}), ...(prepared ? { prepared } : {}) };
	}

	async #worktreeThroughCaller(
		win: ClientWindow,
		caller: SidecarLike,
		callerTabId: string,
		input: WorktreeInput,
	): Promise<RpcWorktreeCreateResult> {
		const response = await this.#deps.dispatch(
			win,
			caller,
			callerTabId,
			{ type: "worktree_create", ...input },
			WORKTREE_COMMAND_BUDGETS_MS.worktree_create,
		);
		if (!response.success) throw new Error(`Creating the worktree failed: ${response.error ?? "unknown error"}`);
		return response.data as RpcWorktreeCreateResult;
	}

	/** A worktree on `device` (a paired host, or this computer when undefined) for a caller running elsewhere. */
	async #worktreeOn(device: string | undefined, input: WorktreeInput): Promise<RpcWorktreeCreateResult> {
		if (!device) return createWorktree(input.baseCwd, input, tablessWorktreeBridge);
		const reply = await this.#remote().request<unknown>(
			device,
			GIT_METHODS.worktreeCreate,
			input,
			WORKTREE_COMMAND_BUDGETS_MS.worktree_create,
		);
		const parsed = WorktreeCreateReply.safeParse(reply);
		if (!parsed.success) throw new Error("The device answered the worktree request with something unreadable.");
		return parsed.data as RpcWorktreeCreateResult;
	}

	#remote(): NonNullable<AgentControlHostDeps["remote"]> {
		const remote = this.#deps.remote;
		if (!remote) throw new Error("Paired devices are not available here.");
		return remote;
	}

	/** Git on the computer a session's worktree is on: this one's own, or the paired host's (`host.git.*`). */
	async #git<T>(
		device: string | undefined,
		method: string,
		params: object,
		local: () => Promise<T>,
		extraMs = 0,
	): Promise<T> {
		return device ? this.#remote().request<T>(device, method, params, GIT_REQUEST_TIMEOUT_MS + extraMs) : local();
	}

	/**
	 * `Autopilot.handleCommand` for one tab, as the Autopilot screen sends it; a failure throws its readable message.
	 * A paired host's tab goes through its own link: that host's coordinator answers (`LocalHostServices`), so a run
	 * of a host folder is the host's (worktree, guard, shipping, restart) and its start counts against this device's
	 * daily requests there.
	 */
	async #autopilotCommand(
		win: ClientWindow,
		tabId: string,
		command: { type: "get_autopilot" } | ({ type: "set_autopilot" } & AutopilotAction),
	): Promise<AutopilotStatus & { tabId?: string; sessionPath?: string }> {
		const autopilot = this.#deps.autopilot;
		if (!autopilot) throw new Error("Autopilot is not available here.");
		const sidecar = this.#sidecar(tabId);
		const response = sidecar.device
			? await this.#deps.dispatch(
					win,
					sidecar,
					tabId,
					command as RpcCommand,
					// A start makes the worktree and waits for the run's omp on the host.
					command.type === "set_autopilot" ? MAX_RPC_COMMAND_TIMEOUT_MS : undefined,
				)
			: await autopilot.command(win, sidecar, tabId, command);
		if (!response.success) throw new Error(response.error ?? "Autopilot refused.");
		return response.data as AutopilotStatus;
	}

	#autopilotSource(): AutopilotSource | undefined {
		const deps = this.#deps;
		const autopilot = deps.autopilot;
		if (!autopilot) return undefined;
		const winFor = (tabId: string): ClientWindow => {
			const win = this.#win(tabId) ?? [...this.#windows.values()][0];
			if (!win) throw new Error("That session's window is gone.");
			return win;
		};
		return {
			plan: async sourceTabId => {
				// The folder's repository's default branch, read by the coordinator of the computer it is on.
				const idle = await this.#autopilotCommand(winFor(sourceTabId), sourceTabId, { type: "get_autopilot" });
				return { defaultBranch: idle.branches?.defaultBranch ?? null };
			},
			start: async (callerTabId, sourceTabId, options) => {
				const win = winFor(callerTabId);
				const device = this.#sidecar(sourceTabId).device;
				const started = await this.#autopilotCommand(win, sourceTabId, {
					type: "set_autopilot",
					action: "start",
					...options,
				});
				let tabId = started.tabId;
				if (!tabId) throw new Error("Autopilot named no session for the run.");
				// The run is a tab of the host; here it is that session, opened as a view of the host's tab (one omp).
				if (device) {
					const host = deps.deviceName(device);
					if (!started.sessionPath)
						throw new Error(
							`The run started on ${host}, but its session file is unknown, so it cannot be shown here.`,
						);
					const shown = await deps.spawnTab(win, { device, sessionPath: started.sessionPath });
					if (!shown?.tabId)
						throw new Error(`The run started on ${host}, but its session could not be opened here.`);
					tabId = shown.tabId;
				}
				// The run is the caller's child like a session it opened: family nesting, the review queue, stop without a card.
				this.#windows.set(tabId, win);
				this.#parents.set(tabId, { callerTabId });
				this.#autopilotRuns.add(tabId);
				if (!isOutside(callerTabId)) deps.pool.setTabOpener(tabId, callerTabId);
				return { ...started, tabId };
			},
			status: tabId => this.#autopilotCommand(winFor(tabId), tabId, { type: "get_autopilot" }),
			stop: (tabId, now) =>
				this.#autopilotCommand(winFor(tabId), tabId, { type: "set_autopilot", action: now ? "abort" : "stop" }),
		};
	}

	/** The control tools at all (Settings › Tools & extensions). */
	#controlEnabled(): boolean {
		return agentControlEnabled(this.#deps.prefs.get(AGENT_CONTROL_PREF));
	}

	/** Agents may approve a tool for the owner: full control, or the approve switch. */
	#approveEnabled(): boolean {
		const { prefs } = this.#deps;
		return (
			agentControlFullEnabled(prefs.get(AGENT_CONTROL_FULL_PREF)) ||
			agentControlApproveEnabled(prefs.get(AGENT_CONTROL_APPROVE_PREF))
		);
	}

	#host(): AgentControlHost {
		const deps = this.#deps;
		return {
			enabled: () => this.#controlEnabled(),
			fullEnabled: () => agentControlFullEnabled(deps.prefs.get(AGENT_CONTROL_FULL_PREF)),
			approveEnabled: () => this.#approveEnabled(),
			summaries: device => deps.summaries?.(device)?.sessions ?? [],
			manageEnabled: () =>
				agentControlFullEnabled(deps.prefs.get(AGENT_CONTROL_FULL_PREF)) ||
				agentControlManageEnabled(deps.prefs.get(AGENT_CONTROL_MANAGE_PREF)),
			checkoutPeers: tabId => deps.checkoutPeers?.(tabId) ?? [],
			// The opener this launch saw, else the one the pool kept across a relaunch: its tab id, or (tab ids are new
			// after a relaunch) the tab now holding the opener's session file.
			parentOf: tabId => this.#openerOf(tabId),
			parentTag: tabId => this.#parents.get(tabId)?.tag,
			// What the receiver's bridge answers: the core keeps the report until the receiver's journal holds it
			// (`mail-outbox`) and sends it again to whatever omp holds the receiver's session next.
			mail: async (tabId, content, details, delivery) => {
				// A report to a caller outside OMPdesk goes to its event stream (the control socket), not into a session.
				if (isOutside(tabId)) {
					const text =
						typeof content === "string"
							? content
							: content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
					for (const listener of this.#outsideMail) listener(tabId, text);
					return undefined;
				}
				return this.#sendMail(tabId, content, details, delivery);
			},
			land: (tabId, name, bytes) => this.#land(tabId, name, bytes),
			sentMarks: async (tabId, marks) => {
				const response = await this.#hostCommand(
					tabId,
					{ type: "agent_control_sent", marks },
					SENT_MARKS_TIMEOUT_MS,
				);
				const data = response.success ? (response.data as Partial<SentAnswer> | undefined) : undefined;
				return typeof data?.instance === "string" && Array.isArray(data.journaled)
					? { instance: data.instance, journaled: data.journaled.filter(mark => typeof mark === "string") }
					: null;
			},
			reviewChanged: parentTabId => void this.control.runtime.pushReview(parentTabId).catch(() => undefined),
			tabs: () => this.#hostTabs(),
			outsideCallers: () =>
				Object.fromEntries(
					[...this.#outside].map(([id, caller]) => [
						id,
						{
							tabId: caller.id,
							title: caller.title,
							cwd: caller.cwd,
							status: "ready",
							busy: false,
							asks: [],
							hidden: false,
						} satisfies ControlTab,
					]),
				),
			outsideWindow: () => {
				const win = deps.outsideWindow?.();
				return win && !win.isDestroyed() ? String(win.webContents.id) : undefined;
			},
			devices: () =>
				(deps.remote?.hosts() ?? []).map(host => ({ id: host.deviceId, name: host.name, state: host.state })),
			stored: async (device, query) => {
				const hidden = this.#hiddenPaths();
				let rows: SessionInfo[];
				let matches: SessionContentMatch[] | null = null;
				if (device) {
					const remote = deps.remote;
					if (!remote) throw new Error("Paired devices are not available here.");
					rows = (await remote.request<SessionInfo[]>(device, "sessions.list", { scope: "global" })).map(row => ({
						...row,
						device,
					}));
					if (query)
						matches = await remote.request<SessionContentMatch[]>(device, "sessions.search", {
							query,
							scope: "global",
						});
				} else {
					const sessions = deps.sessions;
					if (!sessions) throw new Error("Stored sessions are not available here.");
					rows = await sessions.list();
					if (query)
						matches = await sessions.search(
							query,
							rows.map(row => row.path),
						);
				}
				const snippets = new Map((matches ?? []).map(match => [match.path, match.snippet]));
				const needle = query?.toLowerCase();
				// Where a row no tab here holds is open, who holds it and what that tab does, from the summaries of the
				// computer it runs on: on the paired host, its own list (`heldOnHost`) and its summaries (unknown from an
				// older host or offline); here, a tab this computer runs for a paired device.
				const summaries = deps.summaries?.(device) ?? null;
				const summaryOf = new Map(summaries?.sessions.map(session => [session.sessionPath, session]));
				const elsewhere = (row: SessionInfo): OpenElsewhere | undefined => {
					const summary = summaryOf.get(row.path);
					if (device) {
						if (!row.heldOnHost && !summary) return undefined;
						const work = summary ? summaryWork(summary) : summaries ? "idle" : undefined;
						return { ...(summary?.openFor ? { holder: summary.openFor } : {}), ...(work ? { work } : {}) };
					}
					if (!summary?.openFor) return undefined;
					const work = summaryWork(summary);
					return { holder: summary.openFor, ...(work ? { work } : {}) };
				};
				return rows.flatMap(row => {
					const named =
						needle !== undefined && `${row.title ?? ""} ${row.firstMessage}`.toLowerCase().includes(needle);
					if (matches && !snippets.has(row.path) && !named) return [];
					const tab = deps.pool.sessionOwner(row.path, device)?.tabId;
					const open = tab ? undefined : elsewhere(row);
					const snippet = snippets.get(row.path);
					return [
						{
							id: row.id,
							path: row.path,
							title: row.title ?? "",
							firstMessage: row.firstMessage,
							cwd: row.cwd,
							modified: row.modified,
							messages: row.messageCount,
							status: row.status,
							hidden: !device && hidden.has(row.path),
							...(device ? { device, deviceName: deps.deviceName(device) } : {}),
							...(tab ? { tabId: tab } : open ? { elsewhere: open } : {}),
							...(snippet ? { snippet } : {}),
						},
					];
				});
			},
			storedMessages: session => {
				if (session.device) {
					const remote = deps.remote;
					if (!remote) return Promise.reject(new Error("Paired devices are not available here."));
					return remote.request<AgentMessage[]>(session.device, "sessions.messages", {
						sessionPath: session.path,
					});
				}
				const sessions = deps.sessions;
				if (!sessions) return Promise.reject(new Error("Stored sessions are not available here."));
				return sessions.read(session.path);
			},
			sessionPace: async session => {
				try {
					if (session.device) {
						const remote = deps.remote;
						if (!remote) return undefined;
						const pace = await remote.request<Pace | null>(session.device, "sessions.pace", {
							sessionPath: session.path,
						});
						return pace ?? undefined;
					}
					return await deps.sessions?.pace?.(session.path);
				} catch {
					return undefined;
				}
			},
			command: (tabId, command, timeoutMs) => {
				const win = this.#win(tabId) ?? [...this.#windows.values()][0];
				const sidecar = deps.pool.sidecarOf(tabId);
				if (!win || !sidecar)
					return Promise.resolve({
						type: "response",
						success: false,
						error: "That session is gone.",
					} as RpcResponse);
				return deps.dispatch(win, sidecar, tabId, command, timeoutMs);
			},
			spawn: (callerTabId, request) => this.#spawn(callerTabId, request),
			autopilot: this.#autopilotSource(),
			start: tabId => void deps.pool.startTab(tabId),
			setTask: (tabId, task) => deps.pool.setTabTask(tabId, task),
			release: async (_callerTabId, tabId) => {
				const win = deps.pool.windowOfTab(tabId);
				if (!win || !isWebWindow(win.webContents.id)) return false;
				// The page's word may change while the release awaits: the core's rule (`rules/tab_close.rs`) released a
				// page's tab only while its page held no unsaved Files edits, and that is asked again on the store now.
				const id = win.webContents.id;
				return deps.releaseTab(win, tabId, () => deps.fileEdits.edits(id, tabId) !== "dirty");
			},
			view: (callerTabId, event: AgentControlViewEvent) => {
				// The window that holds the session (another window's tab closes or shows there), else the caller's.
				const win = deps.pool.windowOfTab(event.tabId) ?? this.#win(callerTabId);
				if (win && !win.isDestroyed()) win.webContents.send(AGENT_CONTROL_VIEW, event);
			},
			exited: tabId => deps.pool.whenTabExited(tabId),
			notify: (callerTabId, title, body) => {
				const win = this.#win(callerTabId);
				if (win && !win.isDestroyed()) deps.notify(win, callerTabId, title, body);
			},
			confirm: (callerTabId, title, message) => this.#confirm(callerTabId, title, message),
			answer: async (tabId, requestId, response: ExtensionUIResponse) => {
				if (!(await deps.pool.routeSideChannel(requestId, response, tabId)))
					throw new Error("That question is not open any more.");
			},
			markAnswered: async (tabId, byTitle) => {
				await this.#hostCommand(tabId, {
					type: "agent_control_note",
					text: deps.text("answeredBy", { by: byTitle }),
				});
			},
			deleteSession: async (_callerTabId, tabId) => {
				const win = this.#win(tabId);
				const info = win ? deps.pool.tabsForWindow(win).find(tab => tab.tabId === tabId) : undefined;
				if (!info?.sessionPath) throw new Error("That session has no saved file yet; closing it is enough.");
				await deps.deleteSession(info.sessionPath, info.device);
			},
			deleteStored: session => deps.deleteSession(session.path, session.device),
			branchFacts: (worktree, device) =>
				this.#git<BranchFacts>(device, GIT_METHODS.facts, { worktree: gitRef(worktree) }, () =>
					branchFacts(worktree),
				),
			branchEvidence: (worktree, diffChars, device) =>
				this.#git<BranchEvidence>(device, GIT_METHODS.evidence, { worktree: gitRef(worktree), diffChars }, () =>
					branchEvidence(worktree, diffChars),
				),
			mergeBranch: (worktree, label, device) =>
				this.#git<MergeOutcome>(
					device,
					GIT_METHODS.merge,
					{ worktree: gitRef(worktree), label },
					() => mergeBranch(worktree, label),
					MERGE_HOOKS_BUDGET_MS,
				),
			landing: (worktree, device) =>
				this.#git<LandingFacts>(device, GIT_METHODS.landing, { worktree: gitRef(worktree) }, () =>
					landingFacts(worktree),
				),
			removeSafeWorktree: (worktree, device) =>
				this.#git<WorktreeRemoval>(device, GIT_METHODS.removeWorktree, { worktree: gitRef(worktree) }, () =>
					removeSafeWorktree(worktree),
				),
			discardWorktree: (worktree, device) =>
				this.#git<WorktreeRemoval>(device, GIT_METHODS.discardWorktree, { worktree: gitRef(worktree) }, () =>
					discardOpenedWorktree(worktree, { openFolders: sessionOpenFolders }),
				),
			recordClosed: child => this.#recordClosed(child),
			closedChildren: () => parseClosedChildren(deps.prefs.get(AGENT_CLOSED_CHILDREN_PREF)),
			tombstones: () => tombstones(),
			hasSchedules: device => (device ? deps.remote !== undefined : deps.schedules?.() != null),
			schedules: device => {
				// The machine that runs the schedules: this computer's service, or a paired host's own over the link
				// (`host.schedules.*`), which checks the draft the same way.
				if (device) {
					const remote = deps.remote;
					if (!remote) return null;
					return {
						command: async request =>
							SchedulesStateSchema.parse(
								await remote.request<unknown>(device, "host.schedules.command", { request }),
							),
						create: async draft =>
							ScheduleCreatedSchema.parse(
								await remote.request<unknown>(device, "host.schedules.create", { draft }),
							),
					} satisfies SchedulesHost;
				}
				const service = deps.schedules?.();
				if (!service) return null;
				return {
					command: request => service.command(request),
					create: draft => service.create(draft),
				} satisfies SchedulesHost;
			},
			observe: listener => deps.pool.observeTabs(() => listener()),
			isStopping: callerTabId => deps.isStopping?.(callerTabId) === true,
			beforeFirstPrompt: deps.beforeFirstPrompt,
			text: deps.text,
			appPorts: deps.app ? this.#appPorts(deps.app) : undefined,
			runtime: {
				...(deps.sweepMs === undefined ? {} : { sweepMs: deps.sweepMs }),
				reach: sessionPath => this.#reach(sessionPath),
				reviewSent: (callerTabId, review) => this.#reviewSent(callerTabId, review),
				nextPromptChildren: (callerTabId, children) =>
					void this.#hostCommand(callerTabId, { type: "set_next_prompt_children", children }),
				closedChildren: rows => this.#setClosedChildren(rows),
				wakeDone: (runId, result) => {
					this.#wakes.get(runId)?.(result);
					this.#wakes.delete(runId);
				},
			},
		};
	}

	async #confirm(callerTabId: string, title: string, message: string): Promise<boolean> {
		// An outside caller has no session to raise the card in: the same card shows over its window (no answer = no),
		// one at a time per caller, so a process cannot stack dialogs on the person.
		if (isOutside(callerTabId)) {
			const previous = this.#outsideCards.get(callerTabId) ?? Promise.resolve();
			const card = previous.then(() => {
				const win = this.#win(callerTabId);
				const caller = this.#outside.get(callerTabId);
				const confirm = this.#deps.confirmOutside;
				return win && !win.isDestroyed() && caller && confirm
					? confirm(win, caller, `${AGENT_CARD_PREFIX}${title}`, message).catch(() => false)
					: false;
			});
			const settled = card.then(() => undefined);
			this.#outsideCards.set(callerTabId, settled);
			void settled.then(() => {
				if (this.#outsideCards.get(callerTabId) === settled) this.#outsideCards.delete(callerTabId);
			});
			return card;
		}
		const response = await this.#hostCommand(callerTabId, {
			type: "agent_control_confirm",
			title: `${AGENT_CARD_PREFIX}${title}`,
			message,
		});
		return response.success && (response.data as { approved?: boolean } | undefined)?.approved === true;
	}

	#appPorts(app: NonNullable<AgentControlHostDeps["app"]>): NonNullable<AgentControlHost["appPorts"]> {
		const deps = this.#deps;
		const window = (tabId: string): ClientWindow => {
			const win = this.#win(tabId);
			if (!win || win.isDestroyed()) throw new Error("This session's window is gone.");
			return win;
		};
		return {
			getPref: key => deps.prefs.get(key),
			setPref: async (tabId, key, value) => {
				await app.invoke(window(tabId), IPC_COMMANDS.PREFS_SET, [{ key, value }]);
			},
			rpc: (tabId, command) => this.#hostCommand(tabId, command),
			invoke: (tabId, channel, args) => app.invoke(window(tabId), channel, args),
			fire: (tabId, channel, args) => app.fire(window(tabId), channel, args),
			send: (tabId, event) => {
				const win = this.#win(tabId);
				if (win && !win.isDestroyed()) win.webContents.send(AGENT_CONTROL_APP, event);
			},
			manageEnabled: () => agentControlManageEnabled(deps.prefs.get(AGENT_CONTROL_MANAGE_PREF)),
			fullEnabled: () => agentControlFullEnabled(deps.prefs.get(AGENT_CONTROL_FULL_PREF)),
			note: async (tabId, text) => {
				await this.#hostCommand(tabId, { type: "agent_control_note", text });
			},
			localize: app.localize,
			sidebarView: () => sidebarViewOf(deps.prefs.get(AGENT_HIDDEN_PREFS_KEY)),
			openPrivacyPane: pane => app.openPrivacyPane(pane),
		};
	}

	/** One report to a tab's omp; the bridge's answer (`{duplicate, journaled}` for an id it already holds or queued). */
	/** Put a file on the computer `tabId`'s session runs on: this one's upload folder, or a paired host's through the link. */
	async #land(tabId: string, name: string, bytes: Uint8Array): Promise<Landing> {
		const deps = this.#deps;
		const sidecar = isOutside(tabId) ? undefined : deps.pool.sidecarOf(tabId);
		const device = sidecar?.device;
		if (!device) {
			if (!deps.uploads)
				return { ok: false, error: "This computer does not take attached files", code: "unsupported" };
			return attachHere(deps.uploads, name, bytes);
		}
		const remote = deps.remote;
		if (!remote) return { ok: false, error: "No link to that computer", code: "unsupported" };
		const stored = await uploadToHost(
			(method, params, timeoutMs) =>
				remote.request(device, method, { ...params, rtab: tabId, cwd: sidecar?.cwd }, timeoutMs),
			name,
			bytes,
		);
		return stored.ok && stored.path
			? { ok: true, path: stored.path }
			: { ok: false, error: stored.error ?? "The upload failed", ...(stored.code ? { code: stored.code } : {}) };
	}

	async #sendMail(
		tabId: string,
		content: string | (TextContent | ImageContent)[],
		details: Record<string, unknown>,
		delivery: MailDelivery,
	): Promise<MailAnswer | undefined> {
		const response = await this.#hostCommand(tabId, {
			type: "agent_control_mail",
			content,
			details,
			triggerTurn: delivery.triggerTurn,
			...(delivery.deliverAs ? { deliverAs: delivery.deliverAs } : {}),
		});
		if (!response.success) throw new Error(response.error ?? "The report could not be delivered.");
		return typeof response.data === "object" && response.data !== null ? (response.data as MailAnswer) : undefined;
	}

	async #hostCommand(tabId: string, command: RpcCommand, timeoutMs = CARD_TIMEOUT_MS): Promise<RpcResponse> {
		if (isOutside(tabId))
			return {
				type: "response",
				success: false,
				error: "This goes through the calling session's omp, and a caller outside OMPdesk has none. Ask an agent in an OMPdesk session, or the person, to do it.",
			} as RpcResponse;
		const win = this.#win(tabId);
		const sidecar = this.#deps.pool.sidecarOf(tabId);
		if (!win || !sidecar) return { type: "response", success: false, error: "That session is gone." } as RpcResponse;
		return this.#deps.dispatch(win, sidecar, tabId, command, timeoutMs).catch(
			error =>
				({
					type: "response",
					success: false,
					error: error instanceof Error ? error.message : String(error),
				}) as RpcResponse,
		);
	}
}
