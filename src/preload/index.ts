/**
 * Preload script: exposes the OmpApi on window.omp via contextBridge.
 * All RPC commands delegate to ipcRenderer.invoke(IPC_COMMANDS.RPC_COMMAND, ...).
 * Event subscriptions return unsubscribe functions.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AccountRotationMode, AccountRotationState } from "../shared/account-rotation";
import type { BuiltinReaState } from "../shared/builtin-mcp";
import type { GithubAuthState, GithubStarState } from "../shared/github-auth";
import type {
	CustomProviderInput,
	CustomProvidersConfig,
	DeepLinkPayload,
	HostDesktopState,
	HostUpdateAction,
	HostView,
	IpcActiveTabEnvelope,
	IpcBenchmarkRunOptions,
	IpcBenchmarkRunResult,
	IpcFsListResult,
	IpcFsMediaStreamResult,
	IpcFsReadBinaryResult,
	IpcFsReadImageResult,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	IpcModelSetupRunResult,
	IpcOpenExtensionRequest,
	IpcOpenPathResult,
	IpcRemotePairPayload,
	IpcResumeNotice,
	IpcSessionOpenNewWindowPayload,
	IpcSessionOwner,
	IpcSetTabViewPayload,
	IpcSidecarRestartPayload,
	IpcSidecarStatusPayload,
	IpcSpawnTabPayload,
	IpcSpawnTabResult,
	IpcTabInfo,
	IpcTabStatusPayload,
	IpcWorktreeNotice,
	IpcWorktreePrompt,
	IpcWorktreePromptAnswer,
	LogBatch,
	MenuAction,
	MenuActionPayload,
	ModelOverrideInput,
	NotificationClickPayload,
	OmpApi,
	PeerLimits,
	RemoteDirListing,
	RemoteDiscoveredDevice,
	RemoteState,
	RunProgressState,
	RuntimeErrorReport,
	SessionContentMatch,
	SessionInfo,
	SystemInfo,
	TrayState,
	UpdateStatus,
} from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../shared/ipc-types";
import type { ModelSetupRequest, ModelSetupStatus } from "../shared/model-setup";
import type { OmpUpdatedNotice, OmpUpdateState } from "../shared/omp-update";
import {
	PREVIEW_COMMAND,
	PREVIEW_PAGE,
	PREVIEW_SAVE_PDF,
	PREVIEW_STATE,
	PREVIEW_VISUAL,
	PREVIEW_VISUALS,
	type PreviewState,
	type PreviewVisualEvent,
} from "../shared/preview";
import { createSessionRpcClient, timeoutForCommand } from "../shared/rpc-client";
import type {
	AgentSessionEvent,
	AvailableCommand,
	CommandOutputFrame,
	ConfigUpdateFrame,
	ExtensionErrorFrame,
	ExtensionUIRequest,
	ExtensionUIResponse,
	ModelCatalogUpdateFrame,
	PromptResultFrame,
	RpcBtwFrame,
	RpcCommand,
	RpcLiveFrame,
	RpcResponse,
	SessionInfoUpdateFrame,
	SubagentFrame,
} from "../shared/rpc-types";
import { SCHEDULES_COMMAND, SCHEDULES_LOG, SCHEDULES_STATE, type SchedulesState } from "../shared/schedules";
import type { SetupItemId, SetupState } from "../shared/setup";
import {
	SSH_TOOLS_AGENT,
	SSH_TOOLS_COMMAND,
	SSH_TOOLS_PROMPT,
	SSH_TOOLS_PROMPTS,
	SSH_TOOLS_STATE,
	type SshPrompt,
	type SshToolsState,
} from "../shared/ssh-tools";

function rpcCommand(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
	return ipcRenderer.invoke(IPC_COMMANDS.RPC_COMMAND, {
		command: cmd,
		timeoutMs: timeoutMs ?? timeoutForCommand(cmd),
	});
}

function subscribe<T>(channel: string, callback: (data: T) => void): () => void {
	const listener = (_event: Electron.IpcRendererEvent, data: T) => {
		// Node aborts the remaining listeners of an emit once one throws, so a
		// single bad handler would silently freeze every other feature listening
		// to the same main->renderer channel. Isolate it and report instead.
		try {
			callback(data);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			ipcRenderer.send(IPC_COMMANDS.RUNTIME_ERROR_REPORT, {
				source: "preload",
				message: `IPC handler for "${channel}" failed: ${failure.message}`,
				stack: failure.stack,
				details: { channel },
			} satisfies RuntimeErrorReport);
		}
	};
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.removeListener(channel, listener);
	};
}

let activeTabId: string | null = null;

function subscribeActiveTab<T>(channel: string, callback: (data: T) => void): () => void {
	return subscribe<IpcActiveTabEnvelope<T>>(channel, envelope => {
		if (activeTabId === null || envelope.tabId === activeTabId) callback(envelope.payload);
	});
}

function subscribeTab<T>(channel: string, callback: (data: T, tabId: string) => void): () => void {
	return subscribe<IpcActiveTabEnvelope<T>>(channel, envelope => callback(envelope.payload, envelope.tabId));
}

const api: OmpApi = {
	terminal: {
		request: (tabId, operation) => ipcRenderer.invoke("terminal:request", tabId, operation),
		shells: tabId => ipcRenderer.invoke("terminal:shells", tabId),
	},
	preview: {
		command: request => ipcRenderer.invoke(PREVIEW_COMMAND, request),
		savePdf: () => ipcRenderer.invoke(PREVIEW_SAVE_PDF),
		onState: callback => subscribe<PreviewState>(PREVIEW_STATE, callback),
		page: request => ipcRenderer.invoke(PREVIEW_PAGE, request),
		visuals: () => ipcRenderer.invoke(PREVIEW_VISUALS),
		onVisual: callback => subscribe<PreviewVisualEvent>(PREVIEW_VISUAL, callback),
	},
	schedules: {
		command: request => ipcRenderer.invoke(SCHEDULES_COMMAND, request),
		readLog: runId => ipcRenderer.invoke(SCHEDULES_LOG, runId),
		onState: callback => subscribe<SchedulesState>(SCHEDULES_STATE, callback),
	},
	sshTools: {
		command: request => ipcRenderer.invoke(SSH_TOOLS_COMMAND, request),
		agent: () => ipcRenderer.invoke(SSH_TOOLS_AGENT),
		prompts: () => ipcRenderer.invoke(SSH_TOOLS_PROMPTS),
		onState: callback => subscribe<SshToolsState>(SSH_TOOLS_STATE, callback),
		onPrompt: callback => subscribe<SshPrompt[]>(SSH_TOOLS_PROMPT, callback),
	},
	runtime: {
		report: (error: RuntimeErrorReport) => ipcRenderer.send(IPC_COMMANDS.RUNTIME_ERROR_REPORT, error),
		logPath: () => ipcRenderer.invoke(IPC_COMMANDS.RUNTIME_LOG_PATH) as Promise<string>,
		logSnapshot: () => ipcRenderer.invoke(IPC_COMMANDS.LOG_SNAPSHOT) as Promise<LogBatch>,
		logTail: (maxLines: number) => ipcRenderer.invoke(IPC_COMMANDS.RUNTIME_LOG_TAIL, maxLines) as Promise<string[]>,
	},
	// Fire-and-forget: the guard may show a modal, and the renderer has nothing
	// to learn from the outcome.
	app: {
		quit: () => ipcRenderer.send(IPC_COMMANDS.APP_QUIT),
	},

	rpc: {
		...createSessionRpcClient(rpcCommand),
		commandForTab: (tabId: string, cmd: RpcCommand, timeoutMs?: number) =>
			ipcRenderer.invoke(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, {
				tabId,
				command: cmd,
				timeoutMs: timeoutMs ?? timeoutForCommand(cmd),
			}) as Promise<RpcResponse>,
	},

	events: {
		onBatch: (callback: (events: AgentSessionEvent[]) => void) =>
			subscribeActiveTab<AgentSessionEvent[]>(IPC_EVENTS.EVENTS_BATCH, callback),
		onTabStatus: (callback: (payload: IpcTabStatusPayload) => void) =>
			subscribe<IpcTabStatusPayload>(IPC_EVENTS.TAB_STATUS, callback),
		onExtensionUi: (callback: (request: ExtensionUIRequest, tabId: string) => void) =>
			subscribe<{ request: ExtensionUIRequest; tabId: string }>(IPC_EVENTS.EXTENSION_UI, data =>
				callback(data.request, data.tabId),
			),
		onLiveFrame: (callback: (frame: RpcLiveFrame) => void) =>
			subscribeActiveTab<RpcLiveFrame>(IPC_EVENTS.LIVE_FRAME, callback),
		onBtwFrame: (callback: (frame: RpcBtwFrame) => void) =>
			subscribeActiveTab<RpcBtwFrame>(IPC_EVENTS.BTW_FRAME, callback),
		onConfigUpdate: (callback: (payload: ConfigUpdateFrame) => void) =>
			subscribeActiveTab<ConfigUpdateFrame>(IPC_EVENTS.CONFIG_UPDATE, callback),
		onSessionsChanged: (callback: () => void) => subscribe<undefined>(IPC_EVENTS.SESSIONS_CHANGED, () => callback()),
		onLogBatch: (callback: (batch: LogBatch) => void) => subscribe<LogBatch>(IPC_EVENTS.LOG_LINE, callback),
		onTabBatch: (callback: (events: AgentSessionEvent[], tabId: string) => void) =>
			subscribeTab<AgentSessionEvent[]>(IPC_EVENTS.EVENTS_BATCH, callback),
		onTabSidecarStatus: (callback: (status: IpcSidecarStatusPayload, tabId: string) => void) =>
			subscribeTab<IpcSidecarStatusPayload>(IPC_EVENTS.SIDECAR_STATUS, callback),
		onTabSubagentFrame: (callback: (frame: SubagentFrame, tabId: string) => void) =>
			subscribeTab<SubagentFrame[]>(IPC_EVENTS.SUBAGENT_FRAMES, (frames, tabId) => {
				for (const frame of frames) callback(frame, tabId);
			}),
		onTabModelCatalogUpdate: (callback: (frame: ModelCatalogUpdateFrame, tabId: string) => void) =>
			subscribeTab<ModelCatalogUpdateFrame>(IPC_EVENTS.MODEL_CATALOG_UPDATE, callback),
		onTabCommandsUpdate: (callback: (commands: AvailableCommand[], tabId: string) => void) =>
			subscribeTab<AvailableCommand[]>(IPC_EVENTS.COMMANDS_UPDATE, callback),
		onTabConfigUpdate: (callback: (frame: ConfigUpdateFrame, tabId: string) => void) =>
			subscribeTab<ConfigUpdateFrame>(IPC_EVENTS.CONFIG_UPDATE, callback),
		onTabPromptResult: (callback: (frame: PromptResultFrame, tabId: string) => void) =>
			subscribeTab<PromptResultFrame>(IPC_EVENTS.PROMPT_RESULT, callback),
		onTabCommandOutput: (callback: (frame: CommandOutputFrame, tabId: string) => void) =>
			subscribeTab<CommandOutputFrame>(IPC_EVENTS.COMMAND_OUTPUT, callback),
		onTabSessionInfoUpdate: (callback: (frame: SessionInfoUpdateFrame, tabId: string) => void) =>
			subscribeTab<SessionInfoUpdateFrame>(IPC_EVENTS.SESSION_INFO_UPDATE, callback),
		onTabExtensionError: (callback: (frame: ExtensionErrorFrame, tabId: string) => void) =>
			subscribeTab<ExtensionErrorFrame>(IPC_EVENTS.EXTENSION_ERROR, callback),
		onMenuAction: (callback: (action: MenuAction, payload?: MenuActionPayload) => void) =>
			subscribe<{ action: MenuAction } & MenuActionPayload>(IPC_EVENTS.MENU_ACTION, data =>
				callback(data.action, data),
			),
		onDeepLink: (callback: (link: DeepLinkPayload) => void) =>
			subscribe<DeepLinkPayload>(IPC_EVENTS.DEEP_LINK, callback),
		onNotificationClick: (callback: (payload: NotificationClickPayload) => void) =>
			subscribe<NotificationClickPayload>(IPC_EVENTS.NOTIFICATION_CLICK, callback),
		onUpdaterStatus: (callback: (status: UpdateStatus) => void) =>
			subscribe<UpdateStatus>(IPC_EVENTS.UPDATER_STATUS, callback),
		onBridgeHealth: (callback: () => void) => subscribe<undefined>(IPC_EVENTS.BRIDGE_HEALTH, () => callback()),
	},

	updater: {
		check: () => ipcRenderer.invoke(IPC_COMMANDS.UPDATER_CHECK),
		download: () => ipcRenderer.invoke(IPC_COMMANDS.UPDATER_DOWNLOAD),
		apply: () => ipcRenderer.invoke(IPC_COMMANDS.UPDATER_APPLY),
		getStatus: () => ipcRenderer.invoke(IPC_COMMANDS.UPDATER_GET_STATUS),
		version: () => ipcRenderer.invoke(IPC_COMMANDS.UPDATER_VERSION),
		authInfo: () => ipcRenderer.invoke(IPC_COMMANDS.UPDATER_AUTH_INFO),
		testAuth: (token?: string) => ipcRenderer.invoke(IPC_COMMANDS.UPDATER_AUTH_TEST, token),
		saveAuth: (token: string) => ipcRenderer.invoke(IPC_COMMANDS.UPDATER_AUTH_SAVE, token),
		clearAuth: () => ipcRenderer.invoke(IPC_COMMANDS.UPDATER_AUTH_CLEAR),
	},

	bridgeHealth: {
		take: () => ipcRenderer.invoke(IPC_COMMANDS.BRIDGE_HEALTH_TAKE),
	},

	resume: {
		cancelWait: (tabId: string) => ipcRenderer.invoke(IPC_COMMANDS.RESUME_CANCEL_WAIT, tabId),
		stop: () => ipcRenderer.invoke(IPC_COMMANDS.RESUME_STOP),
		reportOnline: (online: boolean) => ipcRenderer.send(IPC_COMMANDS.CONNECTIVITY_REPORT, online),
		takeNotice: () => ipcRenderer.invoke(IPC_COMMANDS.RESUME_TAKE_NOTICE) as Promise<IpcResumeNotice | null>,
	},

	setup: {
		getState: () => ipcRenderer.invoke(IPC_COMMANDS.SETUP_GET_STATE) as Promise<SetupState>,
		retry: (item: SetupItemId) => ipcRenderer.invoke(IPC_COMMANDS.SETUP_RETRY, item) as Promise<void>,
		cancel: () => ipcRenderer.invoke(IPC_COMMANDS.SETUP_CANCEL) as Promise<boolean>,
		onState: (callback: (state: SetupState) => void) => subscribe<SetupState>(IPC_EVENTS.SETUP_STATE, callback),
	},

	ompUpdate: {
		getState: () => ipcRenderer.invoke(IPC_COMMANDS.OMP_UPDATE_GET_STATE) as Promise<OmpUpdateState>,
		now: () => ipcRenderer.invoke(IPC_COMMANDS.OMP_UPDATE_NOW) as Promise<void>,
		onState: (callback: (state: OmpUpdateState) => void) =>
			subscribe<OmpUpdateState>(IPC_EVENTS.OMP_UPDATE_STATE, callback),
		onUpdated: (callback: (notice: OmpUpdatedNotice) => void) =>
			subscribe<OmpUpdatedNotice>(IPC_EVENTS.OMP_UPDATED, callback),
	},

	githubAuth: {
		refresh: (force?: boolean) =>
			ipcRenderer.invoke(IPC_COMMANDS.GITHUB_AUTH_REFRESH, force === true) as Promise<GithubAuthState>,
		startLogin: () => ipcRenderer.invoke(IPC_COMMANDS.GITHUB_AUTH_LOGIN_START) as Promise<GithubAuthState>,
		openLogin: () => ipcRenderer.invoke(IPC_COMMANDS.GITHUB_AUTH_LOGIN_OPEN) as Promise<GithubAuthState>,
		cancelLogin: () => ipcRenderer.invoke(IPC_COMMANDS.GITHUB_AUTH_LOGIN_CANCEL) as Promise<GithubAuthState>,
		logout: () => ipcRenderer.invoke(IPC_COMMANDS.GITHUB_AUTH_LOGOUT) as Promise<GithubAuthState>,
		switchAccount: (login: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.GITHUB_AUTH_SWITCH, login) as Promise<GithubAuthState>,
		fillIdentity: () => ipcRenderer.invoke(IPC_COMMANDS.GITHUB_AUTH_FILL_IDENTITY) as Promise<GithubAuthState>,
		productStar: (star: boolean) =>
			ipcRenderer.invoke(IPC_COMMANDS.GITHUB_PRODUCT_STAR, star) as Promise<GithubStarState>,
		onState: (callback: (state: GithubAuthState) => void) =>
			subscribe<GithubAuthState>(IPC_EVENTS.GITHUB_AUTH_STATE, callback),
	},

	ui: {
		respondExtensionUi: (response: ExtensionUIResponse, tabId?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.EXTENSION_UI_RESPOND, { response, tabId }) as Promise<void>,
		openRequests: () => ipcRenderer.invoke(IPC_COMMANDS.EXTENSION_UI_OPEN) as Promise<IpcOpenExtensionRequest[]>,
	},

	sessions: {
		list: (scope: "local" | "global", device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSIONS_LIST, { scope, device }) as Promise<SessionInfo[]>,
		delete: (sessionPath: string, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSIONS_DELETE, { sessionPath, device }) as Promise<void>,
		rename: (sessionPath: string, name: string, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSIONS_RENAME, { sessionPath, name, device }) as Promise<void>,
		search: (query: string, scope: "local" | "global", device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSIONS_SEARCH, { query, scope, device }) as Promise<SessionContentMatch[]>,
		move: (sessionPath: string, cwd: string, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSIONS_MOVE, { sessionPath, cwd, device }) as Promise<string>,
		openInNewWindow: (payload: IpcSessionOpenNewWindowPayload) =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSION_OPEN_NEW_WINDOW, payload) as Promise<boolean>,
		consumePendingOpen: () => ipcRenderer.invoke(IPC_COMMANDS.SESSION_CONSUME_PENDING) as Promise<string | null>,
	},

	tabs: {
		list: () => ipcRenderer.invoke(IPC_COMMANDS.GET_TABS) as Promise<IpcTabInfo[]>,
		spawn: (payload: IpcSpawnTabPayload) =>
			ipcRenderer.invoke(IPC_COMMANDS.SPAWN_TAB, payload) as Promise<IpcSpawnTabResult | null>,
		close: (tabId: string) => ipcRenderer.invoke(IPC_COMMANDS.CLOSE_TAB, { tabId }) as Promise<boolean>,
		setActive: async (tabId: string) => {
			const switched = (await ipcRenderer.invoke(IPC_COMMANDS.SET_ACTIVE_TAB, { tabId })) as boolean;
			if (switched) activeTabId = tabId;
			return switched;
		},
		setView: async (
			focusedTabId: string,
			visibleTabIds: string[],
			split?: IpcSetTabViewPayload["split"],
			rememberedSplits?: IpcSetTabViewPayload["rememberedSplits"],
		) => {
			const switched = (await ipcRenderer.invoke(IPC_COMMANDS.SET_TAB_VIEW, {
				focusedTabId,
				visibleTabIds,
				split,
				rememberedSplits,
			})) as boolean;
			if (switched) activeTabId = focusedTabId;
			return switched;
		},
		reorder: (tabIds: string[]) => ipcRenderer.invoke(IPC_COMMANDS.REORDER_TABS, { tabIds }) as Promise<boolean>,
		getSessionOwner: (sessionPath: string, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.GET_SESSION_OWNER, { sessionPath, device }) as Promise<IpcSessionOwner | null>,
	},

	remote: {
		getState: () => ipcRenderer.invoke(IPC_COMMANDS.REMOTE_GET_STATE) as Promise<RemoteState>,
		setHostEnabled: (enabled: boolean) =>
			ipcRenderer.invoke(IPC_COMMANDS.REMOTE_SET_HOST_ENABLED, enabled) as Promise<RemoteState>,
		setDeviceName: (name: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.REMOTE_SET_DEVICE_NAME, name) as Promise<RemoteState>,
		setKeepAwake: (enabled: boolean) =>
			ipcRenderer.invoke(IPC_COMMANDS.REMOTE_SET_KEEP_AWAKE, enabled) as Promise<RemoteState>,
		rotateCode: () => ipcRenderer.invoke(IPC_COMMANDS.REMOTE_ROTATE_CODE) as Promise<RemoteState>,
		revokePeer: (deviceId: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.REMOTE_REVOKE_PEER, deviceId) as Promise<RemoteState>,
		setPeerLimits: (deviceId: string, limits: PeerLimits) =>
			ipcRenderer.invoke(IPC_COMMANDS.REMOTE_SET_PEER_LIMITS, { deviceId, limits }) as Promise<RemoteState>,
		discover: (action: "start" | "stop") =>
			ipcRenderer.invoke(IPC_COMMANDS.REMOTE_DISCOVER, action) as Promise<RemoteDiscoveredDevice[]>,
		pair: (payload: IpcRemotePairPayload) =>
			ipcRenderer.invoke(IPC_COMMANDS.REMOTE_PAIR, payload) as Promise<HostView>,
		removeHost: (deviceId: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.REMOTE_REMOVE_HOST, deviceId) as Promise<RemoteState>,
		listDirs: (deviceId: string, path?: string, query?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.REMOTE_LIST_DIRS, { deviceId, path, query }) as Promise<RemoteDirListing>,
		onState: (callback: (state: RemoteState) => void) => subscribe<RemoteState>(IPC_EVENTS.REMOTE_STATE, callback),
		onDiscovered: (callback: (devices: RemoteDiscoveredDevice[]) => void) =>
			subscribe<RemoteDiscoveredDevice[]>(IPC_EVENTS.REMOTE_DISCOVERED, callback),
	},

	stats: {
		fetch: (path: string, params?: Record<string, string>, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.STATS_FETCH, { path, params, device }),
	},

	bench: {
		run: (options: IpcBenchmarkRunOptions, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.BENCH_RUN, options, device) as Promise<IpcBenchmarkRunResult>,
		abort: (device?: string) => ipcRenderer.invoke(IPC_COMMANDS.BENCH_ABORT, device) as Promise<boolean>,
	},

	modelSetup: {
		run: (request: ModelSetupRequest, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.MODEL_SETUP_RUN, request, device) as Promise<IpcModelSetupRunResult>,
		status: (device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.MODEL_SETUP_STATUS, device) as Promise<ModelSetupStatus>,
		abort: (device?: string) => ipcRenderer.invoke(IPC_COMMANDS.MODEL_SETUP_ABORT, device) as Promise<boolean>,
	},

	system: {
		info: () => ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_INFO) as Promise<SystemInfo>,
		openExternal: (url: string) => ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_OPEN_EXTERNAL, url),
		openPath: (path: string, tabId?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_OPEN_PATH, path, tabId) as Promise<IpcOpenPathResult>,
		revealPath: (path: string, tabId?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_REVEAL_PATH, path, tabId) as Promise<IpcOpenPathResult>,
		showSaveDialog: (defaultPath?: string, filters?: { name: string; extensions: string[] }[]) =>
			ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_SAVE_DIALOG, defaultPath, filters),
		saveImage: (defaultName: string, mimeType: string, data: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_SAVE_IMAGE, defaultName, mimeType, data),
		showOpenDialog: (
			filters?: { name: string; extensions: string[] }[],
			options?: { directory?: boolean; title?: string; buttonLabel?: string },
		) => ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_OPEN_DIALOG, filters, options),
		notify: (title: string, body?: string, tabId?: string) => {
			ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_NOTIFY, { title, body, tabId });
		},
	},

	prefs: {
		get: (key?: string) => ipcRenderer.invoke(IPC_COMMANDS.PREFS_GET, { key }),
		set: (key: string, value: unknown) => ipcRenderer.invoke(IPC_COMMANDS.PREFS_SET, { key, value }),
		getLaunchProfile: (cwd, device) => ipcRenderer.invoke(IPC_COMMANDS.PREFS_GET_LAUNCH_PROFILE, { cwd, device }),
		updateLaunchProfile: (cwd, patch, device) =>
			ipcRenderer.invoke(IPC_COMMANDS.PREFS_UPDATE_LAUNCH_PROFILE, { cwd, patch, device }),
	},

	sidecar: {
		restart: (payload?: IpcSidecarRestartPayload) => ipcRenderer.invoke(IPC_COMMANDS.SIDECAR_RESTART, payload),
		selectProject: () => ipcRenderer.invoke(IPC_COMMANDS.SIDECAR_SELECT_PROJECT),
		setProject: (cwd: string) => ipcRenderer.invoke(IPC_COMMANDS.SIDECAR_SET_PROJECT, { cwd }),
		defaultWorkspace: () => ipcRenderer.invoke(IPC_COMMANDS.SIDECAR_DEFAULT_WORKSPACE) as Promise<string>,
		getStatus: () => ipcRenderer.invoke(IPC_COMMANDS.SIDECAR_STATUS_GET),
	},

	tray: {
		pushState: (state: TrayState) => ipcRenderer.send(IPC_EVENTS.TRAY_STATE_PUSH, state),
	},

	progress: {
		set: (state: RunProgressState) => ipcRenderer.send(IPC_EVENTS.PROGRESS_SET, state),
	},

	windowChrome: {
		setColors: colors => ipcRenderer.send(IPC_EVENTS.WINDOW_CHROME_SET, colors),
	},

	models: {
		listProviders: (device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.MODELS_PROVIDERS_LIST, device) as Promise<CustomProvidersConfig>,
		upsertProvider: (input: CustomProviderInput, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.MODELS_PROVIDER_UPSERT, input, device) as Promise<void>,
		deleteProvider: (id: string, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.MODELS_PROVIDER_DELETE, id, device) as Promise<void>,
		setModelOverride: (provider: string, modelId: string, override: ModelOverrideInput | null, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.MODELS_OVERRIDE_SET, provider, modelId, override, device) as Promise<void>,
		openConfig: (device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.MODELS_CONFIG_OPEN, device) as Promise<{ path: string; opened: boolean }>,
	},

	accountRotation: {
		get: (device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.ACCOUNT_ROTATION_GET, device) as Promise<AccountRotationState>,
		set: (mode: AccountRotationMode, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.ACCOUNT_ROTATION_SET, mode, device) as Promise<AccountRotationState>,
	},
	builtinRea: {
		get: (device?: string) => ipcRenderer.invoke(IPC_COMMANDS.BUILTIN_REA_GET, device) as Promise<BuiltinReaState>,
		set: (enabled: boolean, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.BUILTIN_REA_SET, enabled, device) as Promise<BuiltinReaState>,
	},
	hostDesktop: {
		get: (device?: string) => ipcRenderer.invoke(IPC_COMMANDS.HOST_DESKTOP_GET, device) as Promise<HostDesktopState>,
		update: (action: HostUpdateAction, device?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.HOST_DESKTOP_UPDATE, action, device) as Promise<HostDesktopState>,
	},

	fs: {
		list: (path?: string, maxDepth?: number, maxEntries?: number, tabId?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.FS_LIST, { path, maxDepth, maxEntries, tabId }) as Promise<IpcFsListResult>,
		read: (path: string, maxBytes?: number, tabId?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.FS_READ, { path, maxBytes, tabId }) as Promise<IpcFsReadResult>,
		stat: (path, tabId) => ipcRenderer.invoke(IPC_COMMANDS.FS_STAT, { path, tabId }),
		mutate: (mutation, tabId) => ipcRenderer.invoke(IPC_COMMANDS.FS_MUTATE, { mutation, tabId }),
		search: (request, tabId) => ipcRenderer.invoke(IPC_COMMANDS.FS_SEARCH, { request, tabId }),
		readPlan: (payload: IpcFsReadPlanPayload) =>
			ipcRenderer.invoke(IPC_COMMANDS.FS_READ_PLAN, payload) as Promise<IpcFsReadPlanResult>,
		readImage: (path: string, tabId?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.FS_READ_IMAGE, { path, tabId }) as Promise<IpcFsReadImageResult>,
		readBinary: (path: string, maxBytes?: number, tabId?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.FS_READ_BINARY, { path, maxBytes, tabId }) as Promise<IpcFsReadBinaryResult>,
		mediaStream: (path: string, tabId?: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.FS_MEDIA_STREAM, { path, tabId }) as Promise<IpcFsMediaStreamResult>,
		releaseMediaStream: (url: string) => ipcRenderer.send(IPC_COMMANDS.FS_MEDIA_RELEASE, url),
		pathForFile: (file: File) => webUtils.getPathForFile(file),
	},

	editor: {
		openExternal: (content: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.EDITOR_OPEN_EXTERNAL, { content }) as Promise<{
				ok: boolean;
				unavailable: boolean;
				text: string | null;
				error?: string;
			}>,
	},

	worktreeLifecycle: {
		prompts: () => ipcRenderer.invoke(IPC_COMMANDS.WORKTREE_PROMPTS_GET) as Promise<IpcWorktreePrompt[]>,
		answer: async (id: string, accept: boolean) => {
			const payload: IpcWorktreePromptAnswer = { id, accept };
			await ipcRenderer.invoke(IPC_COMMANDS.WORKTREE_PROMPT_ANSWER, payload);
		},
		onPrompts: (callback: (prompts: IpcWorktreePrompt[]) => void) =>
			subscribe<IpcWorktreePrompt[]>(IPC_EVENTS.WORKTREE_PROMPTS, callback),
		onNotice: (callback: (notice: IpcWorktreeNotice) => void) =>
			subscribe<IpcWorktreeNotice>(IPC_EVENTS.WORKTREE_NOTICE, callback),
	},
};

contextBridge.exposeInMainWorld("omp", api);
