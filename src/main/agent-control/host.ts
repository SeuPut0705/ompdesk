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
import {
	AGENT_CARD_PREFIX,
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
	AGENT_CONTROL_REVIEW,
	AGENT_CONTROL_VIEW,
	AGENT_HIDDEN_PREFS_KEY,
	type AgentControlToolName,
	type AgentControlViewEvent,
	type AgentReviewAction,
	type AgentReviewEvent,
	type AgentReviewItem,
	type AgentReviewResult,
	agentControlEnabled,
	agentHiddenPaths,
} from "../../shared/agent-control";
import type { IpcSpawnTabPayload, IpcSpawnTabResult, IpcTabInfo, IpcTabWorktree } from "../../shared/ipc-types";
import {
	BLOCKING_UI_METHODS,
	type ExtensionUIResponse,
	isSignInRequest,
	type RpcCommand,
	type RpcResponse,
	type RpcWorktreeCreateResult,
} from "../../shared/rpc-types";
import type { Schedule, SchedulesState } from "../../shared/schedules";
import { describePreparation } from "../local/git/worktree-seed";
import type { ScheduleService } from "../schedules";
import type { SidecarPool } from "../sidecar-pool";
import type { SidecarLike } from "../sidecar-types";
import type { ClientWindow } from "../web/client-window";
import { branchFacts, discardWorktree, mergeBranch } from "./branches";
import { AgentLimits } from "./limits";
import {
	AgentControl,
	type AgentControlHost,
	type ControlAsk,
	type ControlTab,
	type OpenedChild,
	type ScheduleRow,
	type SpawnRequest,
	type ToolOutcome,
} from "./service";

/** A confirmation card waits for the person this long. */
const CARD_TIMEOUT_MS = 10 * 60_000;
const WORKTREE_PREFIX = "omp/agent/";
/** A child's activity comes in bursts; its review item is rebuilt (git runs) once it settles. */
const REVIEW_SETTLE_MS = 400;

export interface AgentControlHostDeps {
	pool: Pick<
		SidecarPool,
		| "tabsForWindow"
		| "tabFacts"
		| "observeTabs"
		| "openRequests"
		| "routeSideChannel"
		| "sidecarOf"
		| "startTab"
		| "setTabTask"
		| "setTabOpener"
	>;
	/** The same dispatcher the renderer's RPC commands go through (local handlers, host link, quota). */
	dispatch: (
		win: ClientWindow,
		sidecar: SidecarLike,
		tabId: string,
		command: RpcCommand,
		timeoutMs?: number,
	) => Promise<RpcResponse>;
	spawnTab: (win: ClientWindow, payload: IpcSpawnTabPayload) => Promise<IpcSpawnTabResult | null>;
	prefs: { get(key: string): unknown };
	/** A paired host's display name for a deviceId. */
	deviceName: (deviceId: string) => string;
	/** An OS notification; a click opens the tab. */
	notify: (win: ClientWindow, tabId: string, title: string, body: string) => void;
	/** Close a session's tab and delete its saved file (the sidebar's delete). */
	deleteSession: (sessionPath: string, device: string | undefined) => Promise<void>;
	text: AgentControlHost["text"];
	/** Autopilot's hooks (src/main/autopilot*.ts). */
	isStopping?: (callerTabId: string) => boolean;
	beforeFirstPrompt?: (child: OpenedChild) => Promise<void>;
	/** Settings › Schedules (`ScheduleService`); absent or null where there is none. */
	schedules?: () => Pick<ScheduleService, "state" | "command"> | null;
}

/** The parts of `get_memory_report` the lesson needs. */
interface MemoryReportFacts {
	backend?: string;
	capabilities?: { save?: boolean };
}

function askOf(request: ControlAsk["request"]): boolean {
	return BLOCKING_UI_METHODS[request.method] === true && !isSignInRequest(request);
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
	readonly #turns = new Map<string, number>();
	/** Who opened a tab and for what (Autopilot's tag). */
	readonly #parents = new Map<string, { callerTabId: string; tag?: string }>();
	readonly control: AgentControl;
	/** Debounce timers of the review pushes, per parent tab. */
	readonly #reviewTimers = new Map<string, NodeJS.Timeout>();

	constructor(deps: AgentControlHostDeps, limits: AgentLimits = new AgentLimits()) {
		this.#deps = deps;
		this.control = new AgentControl(this.#host(), limits);
		deps.pool.observeTabs(activity => {
			if (activity.type === "busy") this.#turns.set(activity.tabId, (this.#turns.get(activity.tabId) ?? 0) + 1);
			const parent = this.#parents.get(activity.tabId)?.callerTabId;
			if (parent) this.#pushReview(parent);
			if (activity.type === "released") {
				this.#turns.delete(activity.tabId);
				this.#windows.delete(activity.tabId);
				this.#parents.delete(activity.tabId);
				this.control.released(activity.tabId);
			}
		});
	}

	/** The tab Autopilot (or anyone) opened this one for, if the control tools opened it. */
	parentOf(tabId: string): { callerTabId: string; tag?: string } | undefined {
		return this.#parents.get(tabId);
	}

	/** Execute one control host-tool call made by `callerTabId`'s main agent. */
	async run(win: ClientWindow, callerTabId: string, tool: AgentControlToolName, args: unknown): Promise<ToolOutcome> {
		this.#windows.set(callerTabId, win);
		const outcome = await this.control.run(callerTabId, tool, args);
		if (tool === "ompdesk_session_open" || tool === "ompdesk_merge" || tool === "ompdesk_session_stop")
			this.#pushReview(callerTabId);
		return outcome;
	}

	/** The work board's review queue: list, or Approve / Discard / Dismiss one session this one opened. */
	async review(
		win: ClientWindow,
		callerTabId: string,
		action: AgentReviewAction,
		child?: string,
	): Promise<AgentReviewResult> {
		this.#windows.set(callerTabId, win);
		if (!agentControlEnabled(this.#deps.prefs.get(AGENT_CONTROL_PREF))) return { items: [] };
		const result = await this.control.review(callerTabId, action, child);
		if (action !== "list") this.#sendReview(callerTabId, result.items);
		return result;
	}

	#sendReview(callerTabId: string, items: AgentReviewItem[]): void {
		const win = this.#win(callerTabId);
		if (win && !win.isDestroyed())
			win.webContents.send(AGENT_CONTROL_REVIEW, { tabId: callerTabId, items } satisfies AgentReviewEvent);
	}

	/** The parent's review list changed (a child started, finished or closed): push it after a short settle. */
	#pushReview(callerTabId: string): void {
		clearTimeout(this.#reviewTimers.get(callerTabId));
		const timer = setTimeout(() => {
			this.#reviewTimers.delete(callerTabId);
			void this.control.reviewItems(callerTabId).then(
				items => this.#sendReview(callerTabId, items),
				() => undefined,
			);
		}, REVIEW_SETTLE_MS);
		timer.unref();
		this.#reviewTimers.set(callerTabId, timer);
	}

	#win(tabId: string): ClientWindow | undefined {
		return this.#windows.get(tabId);
	}

	#sidecar(tabId: string): SidecarLike {
		const sidecar = this.#deps.pool.sidecarOf(tabId);
		if (!sidecar) throw new Error("That session's process is gone.");
		return sidecar;
	}

	#hiddenPaths(): Set<string> {
		return agentHiddenPaths(this.#deps.prefs.get(AGENT_HIDDEN_PREFS_KEY));
	}

	#controlTab(info: IpcTabInfo, asks: ControlAsk[], hidden: Set<string>): ControlTab {
		return {
			tabId: info.tabId,
			title: info.title ?? "",
			cwd: info.cwd,
			...(info.device ? { deviceName: this.#deps.deviceName(info.device) } : {}),
			status: info.status,
			busy: this.#deps.pool.tabFacts(info.tabId)?.busy === true,
			asks,
			hidden: !info.device && typeof info.sessionPath === "string" && hidden.has(info.sessionPath),
			...(info.worktree ? { worktree: info.worktree } : {}),
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
		const cwd = await this.#folder(caller, request.folder);
		let worktree: IpcTabWorktree | undefined;
		let prepared: string | null = null;
		if (request.worktree) {
			const base = request.worktree.base;
			if (base !== undefined && base !== "HEAD" && base !== "default")
				throw new Error(
					'worktree.base must be "HEAD" (the folder\'s current commit) or "default" (the default branch).',
				);
			const slug = `agent-${Math.random().toString(36).slice(2, 8)}`;
			const { branchPrefix, name } = splitBranch(request.worktree.branch, slug);
			const response = await this.#deps.dispatch(
				win,
				caller,
				callerTabId,
				{
					type: "worktree_create",
					name,
					baseCwd: cwd,
					baseRef: base === "default" ? "default" : "HEAD",
					branchPrefix,
				},
				960_000,
			);
			if (!response.success) throw new Error(`Creating the worktree failed: ${response.error ?? "unknown error"}`);
			const made = response.data as RpcWorktreeCreateResult;
			worktree = { name, branch: made.branch, baseCwd: made.baseCwd, path: made.path };
			prepared = describePreparation(made);
		}
		const result = await this.#deps.spawnTab(win, {
			cwd: worktree?.path ?? cwd,
			...(worktree ? { worktree } : {}),
			...(caller.device ? { device: caller.device } : {}),
		});
		if (!result?.tabId) throw new Error("The new session could not be started.");
		this.#windows.set(result.tabId, win);
		this.#parents.set(result.tabId, { callerTabId, ...(request.tag ? { tag: request.tag } : {}) });
		// An Autopilot child already sits under its run (`tag`); a session the tool opens nests under its opener.
		if (!request.tag) this.#deps.pool.setTabOpener(result.tabId, callerTabId);
		return { tabId: result.tabId, ...(worktree ? { worktree } : {}), ...(prepared ? { prepared } : {}) };
	}

	#host(): AgentControlHost {
		const deps = this.#deps;
		return {
			enabled: () => agentControlEnabled(deps.prefs.get(AGENT_CONTROL_PREF)),
			approveEnabled: () => deps.prefs.get(AGENT_CONTROL_APPROVE_PREF) === true,
			manageEnabled: () => deps.prefs.get(AGENT_CONTROL_MANAGE_PREF) === true,
			turn: callerTabId => this.#turns.get(callerTabId) ?? 0,
			tabs: callerTabId => {
				const win = this.#win(callerTabId);
				if (!win || win.isDestroyed()) return null;
				const infos = deps.pool.tabsForWindow(win);
				if (!infos.some(info => info.tabId === callerTabId)) return null;
				const open = deps.pool.openRequests(win);
				const hidden = this.#hiddenPaths();
				return infos.map(info =>
					this.#controlTab(
						info,
						open
							.filter(entry => entry.tabId === info.tabId && !entry.signIn && askOf(entry.request))
							.map(entry => ({ id: entry.request.id, request: entry.request })),
						hidden,
					),
				);
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
			start: tabId => void deps.pool.startTab(tabId),
			setTask: (tabId, task) => deps.pool.setTabTask(tabId, task),
			view: (callerTabId, event: AgentControlViewEvent) => {
				const win = this.#win(callerTabId);
				if (win && !win.isDestroyed()) win.webContents.send(AGENT_CONTROL_VIEW, event);
			},
			notify: (callerTabId, title, body) => {
				const win = this.#win(callerTabId);
				if (win && !win.isDestroyed()) deps.notify(win, callerTabId, title, body);
			},
			confirm: async (callerTabId, title, message) => {
				const response = await this.#hostCommand(callerTabId, {
					type: "agent_control_confirm",
					title: `${AGENT_CARD_PREFIX}${title}`,
					message,
				});
				return response.success && (response.data as { approved?: boolean } | undefined)?.approved === true;
			},
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
			deleteSession: async (callerTabId, tabId) => {
				const win = this.#win(callerTabId);
				const info = win ? deps.pool.tabsForWindow(win).find(tab => tab.tabId === tabId) : undefined;
				if (!info?.sessionPath) throw new Error("That session has no saved file yet; closing it is enough.");
				await deps.deleteSession(info.sessionPath, info.device);
			},
			branchFacts: worktree => branchFacts(worktree),
			mergeBranch: (worktree, label) => mergeBranch(worktree, label),
			discardWorktree: worktree => discardWorktree(worktree),
			schedules: () => {
				const service = deps.schedules?.();
				if (!service) return null;
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
					list: () => {
						const state = service.state();
						return state.schedules.map(schedule => rowOf(state, schedule));
					},
					save: async draft => {
						const before = new Set(service.state().schedules.map(schedule => schedule.id));
						const state = await service.command({ action: "save", draft });
						const made = state.schedules.find(schedule => !before.has(schedule.id));
						if (!made) throw new Error("The schedule was not saved.");
						return rowOf(state, made);
					},
					remove: async id => {
						await service.command({ action: "delete", id });
					},
				};
			},
			memoryOn: async callerTabId => {
				const response = await this.#hostCommand(callerTabId, { type: "get_memory_report" });
				const report = response.success ? (response.data as MemoryReportFacts | undefined) : undefined;
				return report?.capabilities?.save === true && report.backend !== "off";
			},
			saveMemory: async (callerTabId, content) => {
				const response = await this.#hostCommand(callerTabId, {
					type: "memory_save",
					content,
					context: "OMPdesk delegation",
				});
				if (!response.success) throw new Error(response.error ?? "Memory could not save the lesson.");
			},
			observe: listener => deps.pool.observeTabs(() => listener()),
			isStopping: callerTabId => deps.isStopping?.(callerTabId) === true,
			beforeFirstPrompt: deps.beforeFirstPrompt,
			text: deps.text,
		};
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
