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
import type {
	AutopilotAction,
	AutopilotShipPolicy,
	AutopilotStatus,
} from "../../../resources/gui-bridge/modes/autopilot-contracts";
import {
	AGENT_CARD_PREFIX,
	AGENT_CLOSED_CHILDREN_PREF,
	AGENT_CONTROL_APP,
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
import {
	type AgentMessage,
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
import type { AppPorts } from "./app-control";
import { branchFacts, discardWorktree, landingFacts, mergeBranch, removeLandedWorktree } from "./branches";
import {
	AgentControl,
	type AgentControlHost,
	type AutopilotSource,
	type ControlAsk,
	type ControlTab,
	type OpenedChild,
	type ScheduleRow,
	type ShipLevel,
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
		| "observeTabs"
		| "openRequests"
		| "routeSideChannel"
		| "sidecarOf"
		| "startTab"
		| "setTabTask"
		| "setTabOpener"
		| "hasDraft"
		| "windowOfTab"
		| "tabWindows"
		| "sessionOwner"
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
		request<T>(deviceId: string, method: string, params: unknown): Promise<T>;
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
	/** Autopilot's hooks (src/main/autopilot*.ts). */
	isStopping?: (callerTabId: string) => boolean;
	beforeFirstPrompt?: (child: OpenedChild) => Promise<void>;
	/** Autopilot's coordinator (`Autopilot.handleCommand`, a repository's default branch); absent where there is none. */
	autopilot?: {
		command: (
			win: ClientWindow,
			sidecar: SidecarLike,
			tabId: string,
			command: { type: "get_autopilot" } | ({ type: "set_autopilot" } & AutopilotAction),
		) => Promise<RpcResponse>;
		defaultBranch: (cwd: string, remote: string) => Promise<string | null>;
	};
	/** Settings › Schedules (`ScheduleService`); absent or null where there is none. */
	schedules?: () => Pick<ScheduleService, "state" | "command"> | null;
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
	/** Tabs a person sent a prompt of their own (`noteUserPrompt`): never closed by themselves. */
	readonly #userPrompted = new Set<string>();
	/** When each tab's current turn started. */
	readonly #busySince = new Map<string, number>();
	/** Run tabs `ompdesk_autopilot` started: they end with their run, not with the rules for opened sessions. */
	readonly #autopilotRuns = new Set<string>();
	/** Debounce timers of the auto-close passes, per opener tab. */
	readonly #sweepTimers = new Map<string, NodeJS.Timeout>();

	constructor(deps: AgentControlHostDeps) {
		this.#deps = deps;
		this.control = new AgentControl(this.#host());
		deps.pool.observeTabs(activity => {
			if (activity.type === "busy") this.#busySince.set(activity.tabId, Date.now());
			else if (activity.type === "idle") this.#busySince.delete(activity.tabId);
			const parent = this.#parents.get(activity.tabId)?.callerTabId;
			if (parent) this.#pushReview(parent);
			// A child finishing, or an opener going idle (it can no longer collect), may let a child close.
			this.#sweepSoon(parent ?? activity.tabId);
			if (activity.type === "released") {
				this.#windows.delete(activity.tabId);
				this.#parents.delete(activity.tabId);
				this.#busySince.delete(activity.tabId);
				this.#userPrompted.delete(activity.tabId);
				this.#autopilotRuns.delete(activity.tabId);
				this.control.released(activity.tabId);
			}
		});
		const every = deps.sweepMs ?? SWEEP_INTERVAL_MS;
		if (every > 0) setInterval(() => this.#sweepAll(), every).unref();
	}

	/** The tab Autopilot (or anyone) opened this one for, if the control tools opened it. */
	parentOf(tabId: string): { callerTabId: string; tag?: string } | undefined {
		return this.#parents.get(tabId);
	}

	/** A person (not an agent) sent `tabId` a prompt: its session never closes by itself again. */
	noteUserPrompt(tabId: string): void {
		if (this.#parents.has(tabId)) this.#userPrompted.add(tabId);
	}

	/** Opened by the control tools' `ompdesk_session_open` (not Autopilot's child or run, not the person). */
	#autoClosable(tabId: string): boolean {
		const parent = this.#parents.get(tabId);
		return parent !== undefined && parent.tag === undefined && !this.#autopilotRuns.has(tabId);
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

	/** Every opener with children, on the timer: a merge or push outside the app is no tab activity. */
	#sweepAll(): void {
		const openers = new Set<string>();
		for (const [childId, parent] of this.#parents) if (this.#autoClosable(childId)) openers.add(parent.callerTabId);
		for (const opener of openers) this.#sweepSoon(opener);
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

	/** Execute one control host-tool call made by `callerTabId`'s main agent. */
	async run(win: ClientWindow, callerTabId: string, tool: AgentControlToolName, args: unknown): Promise<ToolOutcome> {
		this.#windows.set(callerTabId, win);
		const outcome = await this.control.run(callerTabId, tool, args);
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
		if (action !== "list") {
			this.#sendReview(callerTabId, result.items);
			this.#sweepSoon(callerTabId);
		}
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
		return {
			tabId: info.tabId,
			// Until stock names an opened session, it reads as the work it was opened for (`IpcTabInfo.task`).
			title: info.title || info.task || "",
			cwd: info.cwd,
			...(info.device ? { device: info.device, deviceName: this.#deps.deviceName(info.device) } : {}),
			status: info.status,
			busy: this.#deps.pool.tabFacts(info.tabId)?.busy === true,
			asks,
			hidden: !info.device && typeof info.sessionPath === "string" && hidden.has(info.sessionPath),
			here,
			...(info.worktree ? { worktree: info.worktree } : {}),
			...(info.sessionPath ? { sessionPath: info.sessionPath } : {}),
			...(info.task ? { task: info.task } : {}),
			...(info.lastRun ? { lastRun: info.lastRun } : {}),
			autoClosable: this.#autoClosable(info.tabId),
			looked: info.active === true || info.visible === true || (info.viewerCount ?? 0) > 0,
			userTouched: this.#userPrompted.has(info.tabId) || this.#deps.pool.hasDraft(info.tabId),
			...(this.#busySince.has(info.tabId) ? { busySince: this.#busySince.get(info.tabId) } : {}),
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
		if (elsewhere && request.worktree)
			throw new Error(
				"A worktree is made on the computer the calling session runs on; open it without worktree, or from a session on that device.",
			);
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
		const target = worktree?.path ?? cwd;
		const result = await this.#deps.spawnTab(win, {
			...(target !== undefined ? { cwd: target } : {}),
			...(request.sessionPath ? { sessionPath: request.sessionPath } : {}),
			...(worktree ? { worktree } : {}),
			...(device ? { device } : {}),
		});
		if (!result?.tabId) throw new Error("The new session could not be started.");
		this.#windows.set(result.tabId, win);
		this.#parents.set(result.tabId, { callerTabId, ...(request.tag ? { tag: request.tag } : {}) });
		// An Autopilot child already sits under its run (`tag`); a session the tool opens nests under its opener.
		if (!request.tag) this.#deps.pool.setTabOpener(result.tabId, callerTabId);
		return { tabId: result.tabId, ...(worktree ? { worktree } : {}), ...(prepared ? { prepared } : {}) };
	}

	/** `Autopilot.handleCommand` for one run tab, as the Autopilot screen sends it; a failure throws its readable message. */
	async #autopilotCommand(
		win: ClientWindow,
		tabId: string,
		command: { type: "get_autopilot" } | ({ type: "set_autopilot" } & AutopilotAction),
	): Promise<AutopilotStatus> {
		const autopilot = this.#deps.autopilot;
		if (!autopilot) throw new Error("Autopilot is not available here.");
		const response = await autopilot.command(win, this.#sidecar(tabId), tabId, command);
		if (!response.success) throw new Error(response.error ?? "Autopilot refused.");
		return response.data as AutopilotStatus;
	}

	#autopilotSource(): AutopilotSource | undefined {
		const deps = this.#deps;
		const autopilot = deps.autopilot;
		if (!autopilot) return undefined;
		const shipPref = (): { level: ShipLevel; remote: string } => {
			const stored = deps.prefs.get("autopilotShip") as Partial<AutopilotShipPolicy> | undefined;
			return {
				level: stored?.autoRelease?.on ? "release" : stored?.autoPush ? "push" : "commit",
				remote: typeof stored?.remote === "string" && stored.remote ? stored.remote : "origin",
			};
		};
		const winFor = (tabId: string): ClientWindow => {
			const win = this.#win(tabId) ?? [...this.#windows.values()][0];
			if (!win) throw new Error("That session's window is gone.");
			return win;
		};
		return {
			plan: async sourceTabId => {
				const { level, remote } = shipPref();
				const defaultBranch = await autopilot
					.defaultBranch(this.#sidecar(sourceTabId).cwd, remote)
					.catch(() => null);
				return { defaultShip: level, defaultBranch };
			},
			start: async (callerTabId, sourceTabId, options) => {
				const win = winFor(callerTabId);
				const started = (await this.#autopilotCommand(win, sourceTabId, {
					type: "set_autopilot",
					action: "start",
					...options,
				})) as AutopilotStatus & { tabId: string };
				// The run is the caller's child like a session it opened: family nesting, the review queue, stop without a card.
				this.#windows.set(started.tabId, win);
				this.#parents.set(started.tabId, { callerTabId });
				this.#autopilotRuns.add(started.tabId);
				deps.pool.setTabOpener(started.tabId, callerTabId);
				return started;
			},
			status: tabId => this.#autopilotCommand(winFor(tabId), tabId, { type: "get_autopilot" }),
			stop: (tabId, now) =>
				this.#autopilotCommand(winFor(tabId), tabId, { type: "set_autopilot", action: now ? "abort" : "stop" }),
		};
	}

	#host(): AgentControlHost {
		const deps = this.#deps;
		return {
			enabled: () => agentControlEnabled(deps.prefs.get(AGENT_CONTROL_PREF)),
			approveEnabled: () => deps.prefs.get(AGENT_CONTROL_APPROVE_PREF) === true,
			manageEnabled: () => deps.prefs.get(AGENT_CONTROL_MANAGE_PREF) === true,
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
			view: (callerTabId, event: AgentControlViewEvent) => {
				// The window that holds the session (another window's tab closes or shows there), else the caller's.
				const win = deps.pool.windowOfTab(event.tabId) ?? this.#win(callerTabId);
				if (win && !win.isDestroyed()) win.webContents.send(AGENT_CONTROL_VIEW, event);
			},
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
			branchFacts: worktree => branchFacts(worktree),
			mergeBranch: (worktree, label) => mergeBranch(worktree, label),
			discardWorktree: worktree => discardWorktree(worktree),
			landing: worktree => landingFacts(worktree),
			removeLandedWorktree: worktree => removeLandedWorktree(worktree),
			recordClosed: child => this.#recordClosed(child),
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
			manageEnabled: () => deps.prefs.get(AGENT_CONTROL_MANAGE_PREF) === true,
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
