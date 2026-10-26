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
	MAX_NEXT_PROMPT_CHILDREN,
	type NextPromptChild,
} from "../../../resources/gui-bridge/modes/next-prompt-contracts";
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
	type AgentControlToolName,
	type AgentControlViewEvent,
	type AgentReviewEvent,
	type AgentReviewItem,
	type AgentReviewResult,
	agentControlApproveEnabled,
	agentControlEnabled,
	agentControlFullEnabled,
	agentControlManageEnabled,
	agentHiddenPaths,
	type ClosedChild,
	MAX_CLOSED_CHILDREN,
	parseClosedChildren,
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
	isSignInRequest,
	type RpcCommand,
	type RpcResponse,
	type RpcWorktreeCreateResult,
} from "../../shared/rpc-types";
import type {
	Schedule,
	ScheduleCreated,
	ScheduleDraft,
	SchedulesRequest,
	SchedulesState,
} from "../../shared/schedules";
import type { FamilyEdits } from "../../shared/turn-edits";
import { discardOpenedWorktree } from "../disk/saved-worktrees";
import { createWorktree, tablessWorktreeBridge, WORKTREE_COMMAND_BUDGETS_MS } from "../local/git/worktree";
import { describePreparation } from "../local/git/worktree-seed";
import {
	GIT_METHODS,
	GIT_REQUEST_TIMEOUT_MS,
	ScheduleCreatedSchema,
	SchedulesStateSchema,
	WorktreeCreateReply,
} from "../remote/app-protocol";
import type { ScheduleService } from "../schedules";
import type { SidecarPool } from "../sidecar-pool";
import type { SidecarLike } from "../sidecar-types";
import { type ClientWindow, isWebWindow } from "../web/client-window";
import type { FileEditReports } from "../web/file-edit-reports";
import { sessionOpenFolders } from "../worktree-orphans";
import type { AppPorts } from "./app-control";
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
import { CallJournal } from "./call-journal";
import type { MailDelivery } from "./mail";
import { MailOutbox, redeliverMail } from "./mail-outbox";
import {
	AgentControl,
	type AgentControlHost,
	type AutopilotSource,
	type ControlAsk,
	type ControlTab,
	type OpenedChild,
	type ScheduleRow,
	SessionFolderMissing,
	type SpawnRequest,
	type ToolOutcome,
} from "./service";

/** A confirmation card waits for the person this long. */
const CARD_TIMEOUT_MS = 10 * 60_000;
const WORKTREE_PREFIX = "omp/agent/";
/** A child's activity comes in bursts; its review item is rebuilt (git runs) once it settles. */
const REVIEW_SETTLE_MS = 400;
/** A burst of tab activity becomes one auto-close pass after this. */
const SWEEP_SETTLE_MS = 1_000;
/** Opened sessions are looked at this often even without activity (a merge or push elsewhere moves no tab). */
const SWEEP_INTERVAL_MS = 10_000;

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
	};
	/** The paired hosts this computer runs sessions on (Settings › Devices) and a request to one of them. */
	remote?: {
		hosts(): HostView[];
		request<T>(deviceId: string, method: string, params: unknown, timeoutMs?: number): Promise<T>;
	};
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
	/** How often opened sessions are looked at for closing; 0 turns the timer off (default 10 s). */
	sweepMs?: number;
	/** A parent's review list went to its windows: a paired device viewing that session hears it too. */
	reviewSent?: (callerTabId: string, review: AgentReviewResult) => void;
	/** Where accepted reports wait for their receiver's journal (`mail-outbox.ts`); absent: kept in memory only. */
	mailOutboxFile?: string | null;
	/** Where the control-tool calls that change something are recorded (`call-journal.ts`); absent: in memory only. */
	callJournalFile?: string | null;
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
	 */
	releaseTab: (win: ClientWindow, tabId: string) => Promise<boolean>;
	/** Settings › Schedules (`ScheduleService`); absent or null where there is none. */
	schedules?: () => Pick<ScheduleService, "command" | "create"> | null;
	/** The app's own handlers `ompdesk_app` goes through (src/main/ipc.ts): the `IpcRegistry` for the window, `PREFS_SET`, the language. */
	app?: {
		invoke: (win: ClientWindow, channel: string, args: readonly unknown[]) => Promise<unknown>;
		fire: (win: ClientWindow, channel: string, args: readonly unknown[]) => void;
		localize: (en: string, ko: string) => string;
	};
}

function askOf(request: ControlAsk["request"]): boolean {
	return BLOCKING_UI_METHODS[request.method] === true && !isSignInRequest(request);
}

/** What a worktree for a new session is made from (`worktree_create`'s fields). */
type WorktreeInput = { name: string; baseCwd: string; baseRef: "HEAD" | "default"; branchPrefix: string };

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

export class AgentControlRuntime {
	readonly #deps: AgentControlHostDeps;
	readonly #windows = new Map<string, ClientWindow>();
	/** Who opened a tab and for what (Autopilot's tag). */
	readonly #parents = new Map<string, { callerTabId: string; tag?: string }>();
	readonly control: AgentControl;
	/** Debounce timers of the review pushes, per parent tab. */
	readonly #reviewTimers = new Map<string, NodeJS.Timeout>();
	/** The review list last sent per parent tab (JSON), so the timer pushes only what changed. */
	readonly #reviewSent = new Map<string, string>();
	/**
	 * Child tab → the opener whose review list (pushed, or read by its board) last named it. A child restored by a
	 * relaunch has its opener only in the pool, which forgets it with the tab: its release must still reach that board.
	 */
	readonly #listedIn = new Map<string, string>();
	/**
	 * Openers whose timer review is still reading git: the next tick skips them. A review reads every child's branch,
	 * so on a slow machine one tick's read outlived the next and the git processes piled up without end.
	 */
	readonly #sweepReviews = new Set<string>();
	/** Openers whose live read (`liveReview`) has not answered yet: a request meanwhile is dropped. */
	readonly #liveReviews = new Set<string>();
	/** Children whose running turn moved on (the pool's `step`) since their last live read. */
	readonly #moved = new Set<string>();
	/** The running or waiting children last told to each parent's prompt suggestions (JSON). */
	readonly #childrenSent = new Map<string, string>();
	/** Tabs a person sent a prompt of their own (`noteUserPrompt`): never closed by themselves. */
	readonly #userPrompted = new Set<string>();
	/** Run tabs `ompdesk_autopilot` started: they end with their run, not with the rules for opened sessions. */
	readonly #autopilotRuns = new Set<string>();
	/** Debounce timers of the auto-close passes, per opener tab. */
	readonly #sweepTimers = new Map<string, NodeJS.Timeout>();
	/** Accepted reports until the receiver's journal holds them (`mail-outbox.ts`). */
	readonly #outbox: MailOutbox;
	/** Control-tool calls by their identity, so one a paired host re-sends after a relaunch runs once. */
	readonly #calls: CallJournal;
	#redelivering = false;

	constructor(deps: AgentControlHostDeps) {
		this.#deps = deps;
		this.#outbox = new MailOutbox(deps.mailOutboxFile ?? null);
		this.#calls = new CallJournal(deps.callJournalFile ?? null);
		this.control = new AgentControl(this.#host());
		deps.pool.observeTabs(activity => {
			const parent =
				this.#openerOf(activity.tabId) ??
				(activity.type === "released" ? this.#listedIn.get(activity.tabId) : undefined);
			// A running child moved on: the next live read takes its step and cost; nothing else changed.
			if (activity.type === "step") {
				if (parent) this.#moved.add(activity.tabId);
				return;
			}
			if (parent) this.#pushReview(parent);
			// A child's question card tells its opener (local and paired-device children alike); an Autopilot run's
			// children are answered by its approver, and the run reads them itself.
			if (
				activity.type === "ask" &&
				parent &&
				this.#parents.get(activity.tabId)?.tag === undefined &&
				!this.#autopilotRuns.has(parent) &&
				!this.#deps.isAutopilotRun?.(parent)
			)
				this.control.childAsked(parent, activity.tabId, activity.requestId).catch(() => undefined);
			// A turn that ended changed the session's own cost, the base of its family's (sidebar chip, Work tree).
			if (activity.type === "idle") this.#pushReview(activity.tabId);
			// A child finishing, or an opener going idle (it can no longer collect), may let a child close.
			this.#sweepSoon(parent ?? activity.tabId);
			if (activity.type === "released") {
				this.#windows.delete(activity.tabId);
				this.#parents.delete(activity.tabId);
				this.#reviewSent.delete(activity.tabId);
				this.#childrenSent.delete(activity.tabId);
				this.#userPrompted.delete(activity.tabId);
				this.#moved.delete(activity.tabId);
				this.#listedIn.delete(activity.tabId);
				this.control.released(activity.tabId);
			}
		});
		// A paired page's first (or changed) word about its Files editor lets a child it holds close at once, not at the
		// next timer tick.
		deps.fileEdits.onReport(() => {
			for (const opener of this.#openers()) this.#sweepSoon(opener);
		});
		const every = deps.sweepMs ?? SWEEP_INTERVAL_MS;
		if (every > 0)
			setInterval(() => {
				this.#sweepAll();
				this.#redeliverMail();
			}, every).unref();
	}

	/** The tab Autopilot (or anyone) opened this one for, if the control tools opened it. */
	parentOf(tabId: string): { callerTabId: string; tag?: string } | undefined {
		return this.#parents.get(tabId);
	}

	/** A person (not an agent) sent `tabId` a prompt: its session never closes by itself again. */
	noteUserPrompt(tabId: string): void {
		if (this.#openerOf(tabId)) this.#userPrompted.add(tabId);
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
		return info.openedBySession ? (pool.sessionOwner(info.openedBySession)?.tabId ?? undefined) : undefined;
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

	/** Look for sessions to close shortly (one pass absorbs a burst of activity). */
	#sweepSoon(tabId: string): void {
		if (this.#sweepTimers.has(tabId)) return;
		const timer = setTimeout(() => {
			this.#sweepTimers.delete(tabId);
			void this.control.autoClose(tabId).catch(() => undefined);
		}, SWEEP_SETTLE_MS);
		timer.unref();
		this.#sweepTimers.set(tabId, timer);
	}

	/**
	 * Every opener with children, on the timer: a merge, push or commit outside the app is no tab activity, so
	 * neither the auto-close pass nor the work board's review list would otherwise notice that a child's work landed
	 * (it leaves the queue) or appeared (it joins).
	 */
	#sweepAll(): void {
		const openers = this.#openers();
		for (const opener of openers) {
			this.#sweepSoon(opener);
			if (this.#sweepReviews.has(opener)) continue;
			this.#sweepReviews.add(opener);
			void this.control
				.review(opener)
				.then(
					review => {
						const last = this.#reviewSent.get(opener) ?? JSON.stringify({ items: [], usage: {} });
						if (JSON.stringify(review) !== last) this.#sendReview(opener, review);
					},
					() => undefined,
				)
				.finally(() => this.#sweepReviews.delete(opener));
		}
	}

	/** The tabs that opened a session the auto-close pass may close, over every window. */
	#openers(): Set<string> {
		const openers = new Set<string>();
		const { pool } = this.#deps;
		for (const win of pool.tabWindows()) {
			if (win.isDestroyed()) continue;
			for (const info of pool.tabsForWindow(win)) {
				const opener = this.#autoClosable(info) ? this.#openerOf(info.tabId) : undefined;
				if (opener) openers.add(opener);
			}
		}
		return openers;
	}

	/**
	 * A running child's step and cost move inside its turn, with no busy or idle edge to push them. A work board that
	 * shows the opener's children asks for them (`agent_control_review {live: true}`, only while it is mounted in a
	 * visible window: renderer `WorkBoardOpened.tsx` `useLiveReview`); only the running children whose omp sent a step
	 * since (the pool's `step` activity: a tool call started or ended, a reply was written) are read, over the list last
	 * sent, and it is pushed only when they moved and no fuller list went out meanwhile. A child that did nothing costs
	 * nothing, on this computer or over a paired device's link.
	 */
	async liveReview(callerTabId: string): Promise<void> {
		const sent = this.#reviewSent.get(callerTabId);
		if (
			!sent ||
			this.#liveReviews.has(callerTabId) ||
			this.#sweepReviews.has(callerTabId) ||
			this.#reviewTimers.has(callerTabId)
		)
			return;
		const last = JSON.parse(sent) as AgentReviewResult;
		const moved = new Set(
			last.items.flatMap(item => (item.state === "running" && this.#moved.has(item.tabId) ? [item.tabId] : [])),
		);
		if (moved.size === 0) return;
		for (const tabId of moved) this.#moved.delete(tabId);
		this.#liveReviews.add(callerTabId);
		try {
			const review = await this.control.liveReview(callerTabId, last, moved);
			if (!review || this.#reviewSent.get(callerTabId) !== sent) return;
			if (JSON.stringify(review) !== sent) this.#sendReview(callerTabId, review);
		} finally {
			this.#liveReviews.delete(callerTabId);
		}
	}

	/** The closed-children list main keeps (`ClosedChild`), newest last; the child's own record is replaced. */
	#recordClosed(child: ClosedChild): void {
		const { prefs } = this.#deps;
		if (!prefs.set) return;
		const rows = parseClosedChildren(prefs.get(AGENT_CLOSED_CHILDREN_PREF)).filter(row => row.path !== child.path);
		rows.push(child);
		prefs.set(AGENT_CLOSED_CHILDREN_PREF, rows.slice(-MAX_CLOSED_CHILDREN));
		prefs.changed?.(AGENT_CLOSED_CHILDREN_PREF);
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
		) {
			this.#pushReview(callerTabId);
			this.#sweepSoon(callerTabId);
		}
		return outcome;
	}

	/** The host took the result of host call `callId`: its record may be forgotten in time (`CallJournal.acknowledge`). */
	acknowledge(callId: string): void {
		this.#calls.acknowledge(callId);
	}

	/** The work board's opened-session rows: the list of sessions this one opened (read-only; the agent lands them with tools). */
	async review(win: ClientWindow, callerTabId: string): Promise<AgentReviewResult> {
		// A window viewing the tab (a phone) asks too; the owner stays the one its tools answer through.
		if (!this.#deps.pool.windowOfTab(callerTabId)) this.#windows.set(callerTabId, win);
		if (!agentControlEnabled(this.#deps.prefs.get(AGENT_CONTROL_PREF))) return { items: [], usage: {} };
		const review = await this.control.review(callerTabId);
		this.#noteListed(callerTabId, review.items);
		return review;
	}

	#noteListed(callerTabId: string, items: readonly AgentReviewItem[]): void {
		for (const item of items) this.#listedIn.set(item.tabId, callerTabId);
	}

	/** What the sessions this one opened changed (the work board's "Changed" row; read-only). */
	async familyEdits(win: ClientWindow, callerTabId: string, since?: number): Promise<FamilyEdits> {
		if (!this.#deps.pool.windowOfTab(callerTabId)) this.#windows.set(callerTabId, win);
		if (!agentControlEnabled(this.#deps.prefs.get(AGENT_CONTROL_PREF))) return { members: [] };
		return this.control.familyEdits(callerTabId, since);
	}

	/**
	 * To every window showing the opener: its owner and a phone viewing it. A viewer's tab list never holds the
	 * children (they are tabs of the window that opened them), so these rows are all it knows of them: without
	 * them its work strip said nothing while the children worked.
	 */
	#sendReview(callerTabId: string, review: AgentReviewResult): void {
		this.#reviewSent.set(callerTabId, JSON.stringify(review));
		this.#noteListed(callerTabId, review.items);
		const showing = this.#deps.pool.windowsShowingTab(callerTabId);
		const own = this.#win(callerTabId);
		for (const win of own && !showing.includes(own) ? [own, ...showing] : showing)
			if (!win.isDestroyed())
				win.webContents.send(AGENT_CONTROL_REVIEW, { tabId: callerTabId, ...review } satisfies AgentReviewEvent);
		this.#deps.reviewSent?.(callerTabId, review);
		this.#sendChildren(callerTabId, review.items);
	}

	/**
	 * The opener's prompt suggestions learn which sessions it opened still run or wait (bridge next-prompt): those run
	 * in their own tabs, so the opener's omp lists none of them as running work, and a suggestion once told the user
	 * to approve work a child was already doing.
	 */
	#sendChildren(callerTabId: string, items: AgentReviewItem[]): void {
		const children: NextPromptChild[] = items
			.filter(item => item.state === "running" || item.waiting)
			.slice(0, MAX_NEXT_PROMPT_CHILDREN)
			.map(item => ({ title: item.title.slice(0, 200), ...(item.waiting ? { waiting: true } : {}) }));
		const json = JSON.stringify(children);
		if (json === (this.#childrenSent.get(callerTabId) ?? "[]")) return;
		this.#childrenSent.set(callerTabId, json);
		void this.#hostCommand(callerTabId, { type: "set_next_prompt_children", children });
	}

	/** The parent's review list changed (a child started, finished or closed): push it after a short settle. */
	#pushReview(callerTabId: string): void {
		clearTimeout(this.#reviewTimers.get(callerTabId));
		const timer = setTimeout(() => {
			this.#reviewTimers.delete(callerTabId);
			void this.control.review(callerTabId).then(
				review => this.#sendReview(callerTabId, review),
				() => undefined,
			);
		}, REVIEW_SETTLE_MS);
		timer.unref();
		this.#reviewTimers.set(callerTabId, timer);
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

	#controlTab(info: IpcTabInfo, asks: ControlAsk[], hidden: Set<string>, here: boolean): ControlTab {
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
			busy: facts?.busy === true,
			...(info.resuming ? { resuming: true } : {}),
			asks,
			...(plan ? { plan } : {}),
			hidden: !info.device && typeof info.sessionPath === "string" && hidden.has(info.sessionPath),
			here,
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
	async #folder(caller: SidecarLike, folder: string | undefined): Promise<string> {
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
		const caller = this.#sidecar(callerTabId);
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
			const base = request.worktree.base;
			if (base !== undefined && base !== "HEAD" && base !== "default")
				throw new Error(
					'worktree.base must be "HEAD" (the folder\'s current commit) or "default" (the default branch).',
				);
			const slug = `agent-${Math.random().toString(36).slice(2, 8)}`;
			const { branchPrefix, name } = splitBranch(request.worktree.branch, slug);
			const input = { name, baseCwd: cwd, baseRef: base === "default" ? "default" : "HEAD", branchPrefix } as const;
			// The worktree is made on the computer the new session runs on: the caller's own through its tab,
			// another one without a tab of the caller there.
			const made = elsewhere
				? await this.#worktreeOn(device, input).catch((error: unknown) => {
						throw new Error(
							`Creating the worktree failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					})
				: await this.#worktreeThroughCaller(win, caller, callerTabId, input);
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
		this.#parents.set(result.tabId, { callerTabId, ...(request.tag ? { tag: request.tag } : {}) });
		// An Autopilot child already sits under its run (`tag`); a session the tool opens nests under its opener.
		if (!request.tag) this.#deps.pool.setTabOpener(result.tabId, callerTabId);
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
	async #git<T>(device: string | undefined, method: string, params: object, local: () => Promise<T>): Promise<T> {
		return device ? this.#remote().request<T>(device, method, params, GIT_REQUEST_TIMEOUT_MS) : local();
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
				deps.pool.setTabOpener(tabId, callerTabId);
				return { ...started, tabId };
			},
			status: tabId => this.#autopilotCommand(winFor(tabId), tabId, { type: "get_autopilot" }),
			stop: (tabId, now) =>
				this.#autopilotCommand(winFor(tabId), tabId, { type: "set_autopilot", action: now ? "abort" : "stop" }),
		};
	}

	#host(): AgentControlHost {
		const deps = this.#deps;
		return {
			calls: this.#calls,
			enabled: () => agentControlEnabled(deps.prefs.get(AGENT_CONTROL_PREF)),
			fullEnabled: () => agentControlFullEnabled(deps.prefs.get(AGENT_CONTROL_FULL_PREF)),
			approveEnabled: () =>
				agentControlFullEnabled(deps.prefs.get(AGENT_CONTROL_FULL_PREF)) ||
				agentControlApproveEnabled(deps.prefs.get(AGENT_CONTROL_APPROVE_PREF)),
			manageEnabled: () =>
				agentControlFullEnabled(deps.prefs.get(AGENT_CONTROL_FULL_PREF)) ||
				agentControlManageEnabled(deps.prefs.get(AGENT_CONTROL_MANAGE_PREF)),
			checkoutPeers: tabId => deps.checkoutPeers?.(tabId) ?? [],
			// The opener this launch saw, else the one the pool kept across a relaunch: its tab id, or (tab ids are new
			// after a relaunch) the tab now holding the opener's session file.
			parentOf: tabId => this.#openerOf(tabId),
			mail: async (tabId, content, details, delivery) => {
				const answer = await this.#sendMail(tabId, content, details, delivery);
				const id = details.id;
				if (typeof id !== "string" || (answer?.duplicate && answer.journaled)) return;
				// A queued aside is journaled at the receiver's next step boundary (or when a quit disposes it); a killed
				// omp loses it. Keep it until the receiver's journal holds it, and send it again to whatever omp replaces it.
				const win = this.#win(tabId);
				const info = win ? deps.pool.tabsForWindow(win).find(entry => entry.tabId === tabId) : undefined;
				if (info?.sessionPath)
					this.#outbox.keep({
						id,
						sessionPath: info.sessionPath,
						...(info.device ? { device: info.device } : {}),
						content,
						details,
						delivery,
						at: Date.now(),
					});
			},
			reviewChanged: parentTabId => this.#pushReview(parentTabId),
			tabs: callerTabId => {
				const own = this.#win(callerTabId);
				if (!own || own.isDestroyed()) return null;
				if (!deps.pool.tabsForWindow(own).some(info => info.tabId === callerTabId)) return null;
				const hidden = this.#hiddenPaths();
				const seen = new Set<string>();
				const tabs: ControlTab[] = [];
				// The caller's window first (its order is the list's), then every other window of this app.
				for (const win of [own, ...deps.pool.tabWindows().filter(other => other !== own)]) {
					if (win.isDestroyed()) continue;
					const open = deps.pool.openRequests(win);
					for (const info of deps.pool.tabsForWindow(win)) {
						if (seen.has(info.tabId)) continue;
						seen.add(info.tabId);
						const asks = open
							.filter(entry => entry.tabId === info.tabId && !entry.signIn && askOf(entry.request))
							.map(entry => ({ id: entry.request.id, request: entry.request }));
						tabs.push(this.#controlTab(info, asks, hidden, win === own));
					}
				}
				return tabs;
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
				return rows.flatMap(row => {
					const named =
						needle !== undefined && `${row.title ?? ""} ${row.firstMessage}`.toLowerCase().includes(needle);
					if (matches && !snippets.has(row.path) && !named) return [];
					const tab = deps.pool.sessionOwner(row.path, device)?.tabId;
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
							...(tab ? { tabId: tab } : {}),
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
				return win && isWebWindow(win.webContents.id) ? deps.releaseTab(win, tabId) : false;
			},
			onFileEdits: listener => deps.fileEdits.onReport(listener),
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
				this.#git<MergeOutcome>(device, GIT_METHODS.merge, { worktree: gitRef(worktree), label }, () =>
					mergeBranch(worktree, label),
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
			schedules: device => {
				// The machine that runs the schedules: this computer's service, or a paired host's own over the link
				// (`host.schedules.*`), which checks the draft the same way.
				let command: (request: SchedulesRequest) => Promise<SchedulesState>;
				let create: (draft: ScheduleDraft) => Promise<ScheduleCreated>;
				if (device) {
					const remote = deps.remote;
					if (!remote) return null;
					command = async request =>
						SchedulesStateSchema.parse(
							await remote.request<unknown>(device, "host.schedules.command", { request }),
						);
					create = async draft =>
						ScheduleCreatedSchema.parse(
							await remote.request<unknown>(device, "host.schedules.create", { draft }),
						);
				} else {
					const service = deps.schedules?.();
					if (!service) return null;
					command = request => service.command(request);
					create = draft => service.create(draft);
				}
				const rowOf = (state: SchedulesState, schedule: Schedule): ScheduleRow => ({
					id: schedule.id,
					name: schedule.name,
					frequency: schedule.frequency,
					cwd: schedule.cwd,
					enabled: schedule.enabled,
					nextRun: state.nextRuns[schedule.id] ?? null,
					lastStatus: state.runs.find(run => run.scheduleId === schedule.id)?.status ?? null,
				});
				return {
					list: async () => {
						const state = await command({ action: "get" });
						return state.schedules.map(schedule => rowOf(state, schedule));
					},
					save: async draft => {
						// The id comes from the save itself: a diff against an earlier read would hand a concurrent
						// create's schedule to this caller.
						const { id, state } = await create(draft);
						const made = state.schedules.find(schedule => schedule.id === id);
						if (!made) throw new Error("The schedule was not saved.");
						return rowOf(state, made);
					},
					remove: async id => {
						await command({ action: "delete", id });
					},
				};
			},
			observe: listener => deps.pool.observeTabs(() => listener()),
			isStopping: callerTabId => deps.isStopping?.(callerTabId) === true,
			beforeFirstPrompt: deps.beforeFirstPrompt,
			text: deps.text,
			appPorts: deps.app ? this.#appPorts(deps.app) : undefined,
		};
	}

	async #confirm(callerTabId: string, title: string, message: string): Promise<boolean> {
		const response = await this.#hostCommand(callerTabId, {
			type: "agent_control_confirm",
			title: `${AGENT_CARD_PREFIX}${title}`,
			message,
		});
		return response.success && (response.data as { approved?: boolean } | undefined)?.approved === true;
	}

	#appPorts(app: NonNullable<AgentControlHostDeps["app"]>): Omit<AppPorts, "autopilot"> {
		const deps = this.#deps;
		const window = (tabId: string): ClientWindow => {
			const win = this.#win(tabId);
			if (!win || win.isDestroyed()) throw new Error("This session's window is gone.");
			return win;
		};
		return {
			getPref: key => deps.prefs.get(key),
			device: tabId => deps.pool.sidecarOf(tabId)?.device,
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
			confirm: (tabId, title, message) => this.#confirm(tabId, title, message),
			manageEnabled: () => agentControlManageEnabled(deps.prefs.get(AGENT_CONTROL_MANAGE_PREF)),
			fullEnabled: () => agentControlFullEnabled(deps.prefs.get(AGENT_CONTROL_FULL_PREF)),
			note: async (tabId, text) => {
				await this.#hostCommand(tabId, { type: "agent_control_note", text });
			},
			text: (key, params) => deps.text(key, params),
			localize: app.localize,
			callerTitle: tabId => {
				const win = this.#win(tabId);
				const title = win ? deps.pool.tabsForWindow(win).find(tab => tab.tabId === tabId)?.title : undefined;
				return title || "this session";
			},
		};
	}

	/** One report to a tab's omp; the bridge's answer (`{duplicate, journaled}` for an id it already holds or queued). */
	async #sendMail(
		tabId: string,
		content: string,
		details: Record<string, unknown>,
		delivery: MailDelivery,
	): Promise<{ duplicate?: boolean; journaled?: boolean } | undefined> {
		const response = await this.#hostCommand(tabId, {
			type: "agent_control_mail",
			content,
			details,
			triggerTurn: delivery.triggerTurn,
			...(delivery.deliverAs ? { deliverAs: delivery.deliverAs } : {}),
		});
		if (!response.success) throw new Error(response.error ?? "The report could not be delivered.");
		return typeof response.data === "object" && response.data !== null
			? (response.data as { duplicate?: boolean; journaled?: boolean })
			: undefined;
	}

	/** Accepted reports whose receiver's journal does not hold them yet, sent again to its live tab. */
	#redeliverMail(): void {
		if (this.#redelivering) return;
		this.#redelivering = true;
		void redeliverMail(this.#outbox, {
			tabOf: (sessionPath, device) => this.#deps.pool.sessionOwner(sessionPath, device)?.tabId,
			send: (tabId, mail) => this.#sendMail(tabId, mail.content, mail.details, mail.delivery),
		}).finally(() => {
			this.#redelivering = false;
		});
	}

	async #hostCommand(tabId: string, command: RpcCommand): Promise<RpcResponse> {
		const win = this.#win(tabId);
		const sidecar = this.#deps.pool.sidecarOf(tabId);
		if (!win || !sidecar) return { type: "response", success: false, error: "That session is gone." } as RpcResponse;
		return this.#deps.dispatch(win, sidecar, tabId, command, CARD_TIMEOUT_MS).catch(
			error =>
				({
					type: "response",
					success: false,
					error: error instanceof Error ? error.message : String(error),
				}) as RpcResponse,
		);
	}
}
