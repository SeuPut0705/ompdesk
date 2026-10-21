/**
 * The renderer's `window.omp`, built over a transport: Electron's preload passes one over `ipcRenderer`, a
 * paired web device's page one over its WebSocket. Every channel, payload and wrapper is the same either way;
 * only `fs.pathForFile` (a dropped file's local path) stays with the preload, because only Electron knows it.
 */

import type { AccountRotationMode, AccountRotationState } from "./account-rotation";
import {
	AGENT_CONTROL_APP,
	AGENT_CONTROL_REVIEW,
	AGENT_CONTROL_VIEW,
	type AgentAppEvent,
	type AgentControlViewEvent,
	type AgentReviewEvent,
} from "./agent-control";
import type {
	AiMemoryCareSummary,
	AiMemoryDeleted,
	AiMemoryFeedback,
	AiMemoryHandoff,
	AiMemoryLintFinding,
	AiMemoryObservations,
	AiMemoryOverview,
	AiMemoryPage,
	AiMemoryPageRef,
	AiMemoryProfile,
	AiMemoryProject,
	AiMemoryProjectRef,
	AiMemorySession,
	AiMemoryState,
	AiMemorySweep,
	AiMemoryWriteInput,
} from "./ai-memory";
import type { BuiltinReaState } from "./builtin-mcp";
import type { CliToolId, CliUpdateState } from "./cli-update";
import type { DiagnosticBundleRequest, DiagnosticBundleResult } from "./diagnostic-bundle";
import type { DiskCareState } from "./disk-care";
import type { ExtensionUpdateState } from "./extension-update";
import type { GithubAuthState, GithubStarState } from "./github-auth";
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
	IpcExtensionUiPayload,
	IpcFsListResult,
	IpcFsMediaStreamResult,
	IpcFsReadBinaryResult,
	IpcFsReadImageResult,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	IpcHostedSession,
	IpcHostOmpUpdate,
	IpcHostSchedules,
	IpcModelSetupRunResult,
	IpcNotifyKind,
	IpcNotifyPayload,
	IpcOpenExtensionRequest,
	IpcOpenPathResult,
	IpcPrefsChangedPayload,
	IpcSessionOpenNewWindowPayload,
	IpcSessionOwner,
	IpcSetTabViewPayload,
	IpcSidecarRestartPayload,
	IpcSidecarStatusPayload,
	IpcSignIn,
	IpcSignInEndedPayload,
	IpcSpawnTabPayload,
	IpcSpawnTabResult,
	IpcTabInfo,
	IpcTabListChangedPayload,
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
	RemoteState,
	RunProgressState,
	RuntimeErrorReport,
	SessionContentMatch,
	SessionInfo,
	SystemInfo,
	TailnetComputer,
	TrayState,
	UpdateStatus,
} from "./ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "./ipc-types";
import {
	MOBILE_WEB_COMMAND,
	MOBILE_WEB_GET_STATE,
	MOBILE_WEB_STATE,
	type MobileWebState,
	WEB_BLOCKS_LIST,
	WEB_BLOCKS_REMOVE,
	WEB_DEVICE_CONNECTED,
	WEB_DEVICES_CHANGED,
	WEB_DEVICES_LIST,
	WEB_DEVICES_RENAME,
	WEB_DEVICES_REVOKE,
	WEB_DEVICES_SET_GRANTS,
	WEB_DEVICES_SET_LIMITS,
	WEB_PAIRING_REQUEST,
	WEB_PAIRING_RESPOND,
	type WebDeviceConnected,
	type WebDeviceInfo,
	type WebPairingRequest,
} from "./mobile-web";
import type { ModelSetupRequest, ModelSetupStatus } from "./model-setup";
import type { OmpUpdatedNotice, OmpUpdateState } from "./omp-update";
import {
	PREVIEW_COMMAND,
	PREVIEW_PAGE,
	PREVIEW_SAVE_PDF,
	PREVIEW_STATE,
	PREVIEW_STREAM_COPY,
	PREVIEW_STREAM_DIALOG,
	PREVIEW_STREAM_INPUT,
	PREVIEW_STREAM_PDF,
	PREVIEW_STREAM_POLL,
	PREVIEW_VISUAL,
	PREVIEW_VISUALS,
	type PreviewState,
	type PreviewVisualEvent,
} from "./preview";
import type { ProjectOrigin } from "./project-origin";
import { createSessionRpcClient, timeoutForCommand } from "./rpc-client";
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
} from "./rpc-types";
import { SCHEDULES_COMMAND, SCHEDULES_LOG, SCHEDULES_STATE, type SchedulesState } from "./schedules";
import type { GitAslrAction, GitAslrResult, SetupItemId, SetupState } from "./setup";
import { type IpcSidebarProjects, SIDEBAR_PROJECTS_COMMAND, SIDEBAR_PROJECTS_STATE } from "./sidebar-projects";
import {
	SSH_TOOLS_AGENT,
	SSH_TOOLS_COMMAND,
	SSH_TOOLS_PROMPT,
	SSH_TOOLS_PROMPTS,
	SSH_TOOLS_STATE,
	type SshPrompt,
	type SshToolsState,
} from "./ssh-tools";

/** How `window.omp` reaches main: Electron's `ipcRenderer`, or a web device's socket. */
export interface OmpTransport {
	/** A request with a reply. The IPC boundary is untyped: `T` is what the channel's handler returns. */
	invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
	/** Fire-and-forget. */
	send(channel: string, ...args: unknown[]): void;
	/** A main→renderer push channel's payloads; returns the unsubscribe. */
	on(channel: string, listener: (data: unknown) => void): () => void;
}

/** `window.omp` without `fs.pathForFile`, which only the Electron preload can answer. */
export type TransportOmpApi = Omit<OmpApi, "fs"> & { fs: Omit<OmpApi["fs"], "pathForFile"> };

export function createOmpApi(transport: OmpTransport): TransportOmpApi {
	const rpcCommand = (cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> =>
		transport.invoke(IPC_COMMANDS.RPC_COMMAND, {
			command: cmd,
			timeoutMs: timeoutMs ?? timeoutForCommand(cmd),
		});

	function subscribe<T>(channel: string, callback: (data: T) => void): () => void {
		return transport.on(channel, data => {
			// Node aborts the remaining listeners of an emit once one throws, so a
			// single bad handler would silently freeze every other feature listening
			// to the same main->renderer channel. Isolate it and report instead.
			try {
				callback(data as T);
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				transport.send(IPC_COMMANDS.RUNTIME_ERROR_REPORT, {
					source: "preload",
					message: `IPC handler for "${channel}" failed: ${failure.message}`,
					stack: failure.stack,
					details: { channel },
				} satisfies RuntimeErrorReport);
			}
		});
	}

	/** The tab main routes untargeted commands to; full-stream envelopes of other tabs are dropped. */
	let activeTabId: string | null = null;

	function subscribeActiveTab<T>(channel: string, callback: (data: T) => void): () => void {
		return subscribe<IpcActiveTabEnvelope<T>>(channel, envelope => {
			if (activeTabId === null || envelope.tabId === activeTabId) callback(envelope.payload);
		});
	}

	function subscribeTab<T>(channel: string, callback: (data: T, tabId: string) => void): () => void {
		return subscribe<IpcActiveTabEnvelope<T>>(channel, envelope => callback(envelope.payload, envelope.tabId));
	}

	return {
		terminal: {
			request: (tabId, operation) => transport.invoke("terminal:request", tabId, operation),
			shells: tabId => transport.invoke("terminal:shells", tabId),
		},
		preview: {
			command: request => transport.invoke(PREVIEW_COMMAND, request),
			savePdf: () => transport.invoke(PREVIEW_SAVE_PDF),
			onState: callback => subscribe<PreviewState>(PREVIEW_STATE, callback),
			page: request => transport.invoke(PREVIEW_PAGE, request),
			visuals: () => transport.invoke(PREVIEW_VISUALS),
			onVisual: callback => subscribe<PreviewVisualEvent>(PREVIEW_VISUAL, callback),
			stream: {
				poll: request => transport.invoke(PREVIEW_STREAM_POLL, request),
				input: events => transport.send(PREVIEW_STREAM_INPUT, events),
				answerDialog: (id, answer) => transport.invoke(PREVIEW_STREAM_DIALOG, { id, ...answer }),
				selectedText: () => transport.invoke(PREVIEW_STREAM_COPY),
				pdf: () => transport.invoke(PREVIEW_STREAM_PDF),
			},
		},
		schedules: {
			command: (request, device) => transport.invoke(SCHEDULES_COMMAND, request, device),
			readLog: (runId, device) => transport.invoke(SCHEDULES_LOG, runId, device),
			onState: callback => subscribe<SchedulesState>(SCHEDULES_STATE, callback),
			onHostState: callback =>
				subscribe<IpcHostSchedules>(IPC_EVENTS.HOST_SCHEDULES_STATE, update =>
					callback(update.device, update.state),
				),
		},
		sidebarProjects: {
			command: (request, device) => transport.invoke(SIDEBAR_PROJECTS_COMMAND, request, device),
			onState: callback => subscribe<IpcSidebarProjects>(SIDEBAR_PROJECTS_STATE, callback),
		},
		mobileWeb: {
			getState: () => transport.invoke(MOBILE_WEB_GET_STATE),
			command: request => transport.invoke(MOBILE_WEB_COMMAND, request),
			onState: callback => subscribe<MobileWebState>(MOBILE_WEB_STATE, callback),
			devices: {
				list: () => transport.invoke(WEB_DEVICES_LIST),
				revoke: deviceId => transport.invoke(WEB_DEVICES_REVOKE, deviceId),
				blocked: () => transport.invoke(WEB_BLOCKS_LIST),
				unblock: blockId => transport.invoke(WEB_BLOCKS_REMOVE, blockId),
				rename: (deviceId, name) => transport.invoke(WEB_DEVICES_RENAME, deviceId, name),
				setGrants: (deviceId, grants) => transport.invoke(WEB_DEVICES_SET_GRANTS, deviceId, grants),
				setLimits: (deviceId, limits) => transport.invoke(WEB_DEVICES_SET_LIMITS, deviceId, limits),
				onChanged: callback => subscribe<WebDeviceInfo[]>(WEB_DEVICES_CHANGED, callback),
				onConnected: callback => subscribe<WebDeviceConnected>(WEB_DEVICE_CONNECTED, callback),
			},
			pairing: {
				onRequest: callback => subscribe<WebPairingRequest>(WEB_PAIRING_REQUEST, callback),
				respond: response => transport.invoke(WEB_PAIRING_RESPOND, response),
			},
		},
		sshTools: {
			command: request => transport.invoke(SSH_TOOLS_COMMAND, request),
			agent: () => transport.invoke(SSH_TOOLS_AGENT),
			prompts: () => transport.invoke(SSH_TOOLS_PROMPTS),
			onState: callback => subscribe<SshToolsState>(SSH_TOOLS_STATE, callback),
			onPrompt: callback => subscribe<SshPrompt[]>(SSH_TOOLS_PROMPT, callback),
		},
		runtime: {
			report: (error: RuntimeErrorReport) => transport.send(IPC_COMMANDS.RUNTIME_ERROR_REPORT, error),
			logPath: () => transport.invoke(IPC_COMMANDS.RUNTIME_LOG_PATH) as Promise<string>,
			logSnapshot: () => transport.invoke(IPC_COMMANDS.LOG_SNAPSHOT) as Promise<LogBatch>,
			logTail: (maxLines: number) => transport.invoke(IPC_COMMANDS.RUNTIME_LOG_TAIL, maxLines) as Promise<string[]>,
			diagnostics: () => transport.invoke(IPC_COMMANDS.DIAGNOSTICS_BUILD) as Promise<string>,
			startupMark: mark => transport.send(IPC_COMMANDS.RUNTIME_STARTUP_MARK, mark),
		},
		// Fire-and-forget: the guard may show a modal, and the renderer has nothing
		// to learn from the outcome.
		app: {
			quit: () => transport.send(IPC_COMMANDS.APP_QUIT),
		},

		rpc: {
			...createSessionRpcClient(rpcCommand),
			commandForTab: (tabId: string, cmd: RpcCommand, timeoutMs?: number) =>
				transport.invoke(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, {
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
			onExtensionUi: (
				callback: (
					request: ExtensionUIRequest,
					tabId: string,
					signIn?: IpcSignIn,
					resent?: boolean,
					answeredElsewhere?: boolean,
				) => void,
			) =>
				subscribe<IpcExtensionUiPayload>(IPC_EVENTS.EXTENSION_UI, data =>
					callback(data.request, data.tabId, data.signIn, data.resent === true, data.answeredElsewhere === true),
				),
			onSignInEnded: (callback: (payload: IpcSignInEndedPayload) => void) =>
				subscribe<IpcSignInEndedPayload>(IPC_EVENTS.SIGN_IN_ENDED, callback),
			onLiveFrame: (callback: (frame: RpcLiveFrame) => void) =>
				subscribeActiveTab<RpcLiveFrame>(IPC_EVENTS.LIVE_FRAME, callback),
			onBtwFrame: (callback: (frame: RpcBtwFrame) => void) =>
				subscribeActiveTab<RpcBtwFrame>(IPC_EVENTS.BTW_FRAME, callback),
			onConfigUpdate: (callback: (payload: ConfigUpdateFrame) => void) =>
				subscribeActiveTab<ConfigUpdateFrame>(IPC_EVENTS.CONFIG_UPDATE, callback),
			onSessionsChanged: (callback: () => void) =>
				subscribe<undefined>(IPC_EVENTS.SESSIONS_CHANGED, () => callback()),
			onHostedSessionsChanged: (callback: (sessions: IpcHostedSession[]) => void) =>
				subscribe<IpcHostedSession[]>(IPC_EVENTS.HOSTED_SESSIONS_CHANGED, callback),
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
			onTabListChanged: callback => subscribe<IpcTabListChangedPayload>(IPC_EVENTS.TAB_LIST_CHANGED, callback),
			onAgentControlView: callback => subscribe<AgentControlViewEvent>(AGENT_CONTROL_VIEW, callback),
			onAgentControlApp: callback => subscribe<AgentAppEvent>(AGENT_CONTROL_APP, callback),
			onAgentControlReview: callback => subscribe<AgentReviewEvent>(AGENT_CONTROL_REVIEW, callback),
		},

		updater: {
			check: () => transport.invoke(IPC_COMMANDS.UPDATER_CHECK),
			download: () => transport.invoke(IPC_COMMANDS.UPDATER_DOWNLOAD),
			apply: () => transport.invoke(IPC_COMMANDS.UPDATER_APPLY),
			postpone: () => transport.invoke(IPC_COMMANDS.UPDATER_POSTPONE),
			installMode: () => transport.invoke(IPC_COMMANDS.UPDATER_INSTALL_MODE),
			getStatus: () => transport.invoke(IPC_COMMANDS.UPDATER_GET_STATUS),
			version: () => transport.invoke(IPC_COMMANDS.UPDATER_VERSION),
			authInfo: () => transport.invoke(IPC_COMMANDS.UPDATER_AUTH_INFO),
			testAuth: (token?: string) => transport.invoke(IPC_COMMANDS.UPDATER_AUTH_TEST, token),
			saveAuth: (token: string) => transport.invoke(IPC_COMMANDS.UPDATER_AUTH_SAVE, token),
			clearAuth: () => transport.invoke(IPC_COMMANDS.UPDATER_AUTH_CLEAR),
		},

		bridgeHealth: {
			take: () => transport.invoke(IPC_COMMANDS.BRIDGE_HEALTH_TAKE),
		},

		resume: {
			cancelWait: (tabId: string) => transport.invoke(IPC_COMMANDS.RESUME_CANCEL_WAIT, tabId),
			stop: (tabId: string) => transport.invoke(IPC_COMMANDS.RESUME_STOP, tabId),
			reportOnline: (online: boolean) => transport.send(IPC_COMMANDS.CONNECTIVITY_REPORT, online),
		},

		setup: {
			getState: () => transport.invoke(IPC_COMMANDS.SETUP_GET_STATE) as Promise<SetupState>,
			retry: (item: SetupItemId) => transport.invoke(IPC_COMMANDS.SETUP_RETRY, item) as Promise<void>,
			cancel: () => transport.invoke(IPC_COMMANDS.SETUP_CANCEL) as Promise<boolean>,
			gitAslr: (action: GitAslrAction) =>
				transport.invoke(IPC_COMMANDS.SETUP_GIT_ASLR, action) as Promise<GitAslrResult>,
			onState: (callback: (state: SetupState) => void) => subscribe<SetupState>(IPC_EVENTS.SETUP_STATE, callback),
		},

		cliUpdate: {
			getState: () => transport.invoke(IPC_COMMANDS.CLI_UPDATE_GET_STATE) as Promise<CliUpdateState>,
			now: (tool?: CliToolId) => transport.invoke(IPC_COMMANDS.CLI_UPDATE_NOW, tool) as Promise<void>,
			onState: (callback: (state: CliUpdateState) => void) =>
				subscribe<CliUpdateState>(IPC_EVENTS.CLI_UPDATE_STATE, callback),
		},

		aiMemory: {
			getState: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_GET_STATE) as Promise<AiMemoryState>,
			setEnabled: (enabled: boolean) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_SET_ENABLED, enabled) as Promise<void>,
			retry: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_RETRY) as Promise<void>,
			purge: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_PURGE) as Promise<void>,
			setTerminal: (enabled: boolean) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, enabled) as Promise<void>,
			openWeb: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_OPEN_WEB) as Promise<void>,
			copyWebPassword: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD) as Promise<void>,
			revealData: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_REVEAL_DATA) as Promise<void>,
			projects: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_PROJECTS) as Promise<AiMemoryProject[]>,
			search: (query: string, project?: AiMemoryProjectRef) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_SEARCH, query, project) as Promise<AiMemoryPageRef[]>,
			recent: (project?: AiMemoryProjectRef) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_RECENT, project) as Promise<AiMemoryPageRef[]>,
			handoffs: (project?: AiMemoryProjectRef) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_HANDOFFS, project) as Promise<AiMemoryHandoff[]>,
			readPage: (ref: AiMemoryProjectRef & { path: string }) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_READ_PAGE, ref) as Promise<AiMemoryPage>,
			overview: (project: AiMemoryProjectRef) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_OVERVIEW, project) as Promise<AiMemoryOverview>,
			pages: (project: AiMemoryProjectRef) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_PAGES, project) as Promise<AiMemoryPageRef[]>,
			sessions: (project: AiMemoryProjectRef) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_SESSIONS, project) as Promise<AiMemorySession[]>,
			observations: (project: AiMemoryProjectRef, sessionId: string, offset?: number) =>
				transport.invoke(
					IPC_COMMANDS.AI_MEMORY_OBSERVATIONS,
					project,
					sessionId,
					offset,
				) as Promise<AiMemoryObservations>,
			profile: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_PROFILE) as Promise<AiMemoryProfile>,
			lint: (project: AiMemoryProjectRef) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_LINT, project) as Promise<AiMemoryLintFinding[]>,
			sweep: (project: AiMemoryProjectRef, dryRun: boolean) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_SWEEP, project, dryRun) as Promise<AiMemorySweep>,
			writePage: (input: AiMemoryWriteInput) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_WRITE_PAGE, input) as Promise<void>,
			deletePage: (ref: AiMemoryProjectRef & { path: string; title?: string }) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_DELETE_PAGE, ref) as Promise<AiMemoryDeleted>,
			restorePage: (ref: AiMemoryProjectRef & { path: string }, rev: string) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_RESTORE_PAGE, ref, rev) as Promise<void>,
			feedback: (ref: AiMemoryProjectRef & { path: string }, signal: AiMemoryFeedback) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_FEEDBACK, ref, signal) as Promise<void>,
			cancelHandoff: (project: AiMemoryProjectRef, id: string) =>
				transport.invoke(IPC_COMMANDS.AI_MEMORY_CANCEL_HANDOFF, project, id) as Promise<void>,
			care: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_CARE) as Promise<AiMemoryCareSummary | null>,
			undoCare: () => transport.invoke(IPC_COMMANDS.AI_MEMORY_CARE_UNDO) as Promise<number>,
			onState: (callback: (state: AiMemoryState) => void) =>
				subscribe<AiMemoryState>(IPC_EVENTS.AI_MEMORY_STATE, callback),
		},

		extensionUpdate: {
			getState: () => transport.invoke(IPC_COMMANDS.EXTENSION_UPDATE_GET_STATE) as Promise<ExtensionUpdateState>,
			now: (key?: string) => transport.invoke(IPC_COMMANDS.EXTENSION_UPDATE_NOW, key) as Promise<void>,
			onState: (callback: (state: ExtensionUpdateState) => void) =>
				subscribe<ExtensionUpdateState>(IPC_EVENTS.EXTENSION_UPDATE_STATE, callback),
		},

		ompUpdate: {
			getState: () => transport.invoke(IPC_COMMANDS.OMP_UPDATE_GET_STATE) as Promise<OmpUpdateState>,
			now: () => transport.invoke(IPC_COMMANDS.OMP_UPDATE_NOW) as Promise<void>,
			onState: (callback: (state: OmpUpdateState) => void) =>
				subscribe<OmpUpdateState>(IPC_EVENTS.OMP_UPDATE_STATE, callback),
			onUpdated: (callback: (notice: OmpUpdatedNotice) => void) =>
				subscribe<OmpUpdatedNotice>(IPC_EVENTS.OMP_UPDATED, callback),
		},

		hostOmpUpdate: {
			get: (device: string) => transport.invoke(IPC_COMMANDS.HOST_OMP_UPDATE_GET, device) as Promise<OmpUpdateState>,
			now: (device: string) => transport.invoke(IPC_COMMANDS.HOST_OMP_UPDATE_NOW, device) as Promise<OmpUpdateState>,
			onState: (callback: (update: IpcHostOmpUpdate) => void) =>
				subscribe<IpcHostOmpUpdate>(IPC_EVENTS.HOST_OMP_UPDATE_STATE, callback),
		},

		diskCare: {
			getState: () => transport.invoke(IPC_COMMANDS.DISK_CARE_GET_STATE) as Promise<DiskCareState>,
			run: () => transport.invoke(IPC_COMMANDS.DISK_CARE_RUN) as Promise<DiskCareState>,
			onState: (callback: (state: DiskCareState) => void) =>
				subscribe<DiskCareState>(IPC_EVENTS.DISK_CARE_STATE, callback),
		},

		githubAuth: {
			refresh: (force?: boolean) =>
				transport.invoke(IPC_COMMANDS.GITHUB_AUTH_REFRESH, force === true) as Promise<GithubAuthState>,
			startLogin: () => transport.invoke(IPC_COMMANDS.GITHUB_AUTH_LOGIN_START) as Promise<GithubAuthState>,
			openLogin: () => transport.invoke(IPC_COMMANDS.GITHUB_AUTH_LOGIN_OPEN) as Promise<GithubAuthState>,
			cancelLogin: () => transport.invoke(IPC_COMMANDS.GITHUB_AUTH_LOGIN_CANCEL) as Promise<GithubAuthState>,
			logout: () => transport.invoke(IPC_COMMANDS.GITHUB_AUTH_LOGOUT) as Promise<GithubAuthState>,
			switchAccount: (login: string) =>
				transport.invoke(IPC_COMMANDS.GITHUB_AUTH_SWITCH, login) as Promise<GithubAuthState>,
			fillIdentity: () => transport.invoke(IPC_COMMANDS.GITHUB_AUTH_FILL_IDENTITY) as Promise<GithubAuthState>,
			productStar: (star: boolean) =>
				transport.invoke(IPC_COMMANDS.GITHUB_PRODUCT_STAR, star) as Promise<GithubStarState>,
			onState: (callback: (state: GithubAuthState) => void) =>
				subscribe<GithubAuthState>(IPC_EVENTS.GITHUB_AUTH_STATE, callback),
		},

		ui: {
			respondExtensionUi: (response: ExtensionUIResponse, tabId?: string) =>
				transport.invoke(IPC_COMMANDS.EXTENSION_UI_RESPOND, { response, tabId }) as Promise<void>,
			openRequests: () => transport.invoke(IPC_COMMANDS.EXTENSION_UI_OPEN) as Promise<IpcOpenExtensionRequest[]>,
			shownState: () => transport.invoke(IPC_COMMANDS.EXTENSION_UI_STATE) as Promise<IpcOpenExtensionRequest[]>,
		},

		sessions: {
			list: (scope: "local" | "global", device?: string) =>
				transport.invoke(IPC_COMMANDS.SESSIONS_LIST, { scope, device }) as Promise<SessionInfo[]>,
			delete: (sessionPath: string, device?: string) =>
				transport.invoke(IPC_COMMANDS.SESSIONS_DELETE, { sessionPath, device }) as Promise<void>,
			/** Stop every turn on the session (on `device` when given) and resolve once they have ended. */
			stop: (sessionPath: string, device?: string) =>
				transport.invoke(IPC_COMMANDS.SESSIONS_STOP, { sessionPath, device }) as Promise<void>,
			rename: (sessionPath: string, name: string, device?: string) =>
				transport.invoke(IPC_COMMANDS.SESSIONS_RENAME, { sessionPath, name, device }) as Promise<void>,
			search: (query: string, scope: "local" | "global", device?: string) =>
				transport.invoke(IPC_COMMANDS.SESSIONS_SEARCH, { query, scope, device }) as Promise<SessionContentMatch[]>,
			move: (sessionPath: string, cwd: string, device?: string) =>
				transport.invoke(IPC_COMMANDS.SESSIONS_MOVE, { sessionPath, cwd, device }) as Promise<string>,
			saveDiagnosticBundle: (request: DiagnosticBundleRequest) =>
				transport.invoke(IPC_COMMANDS.SESSIONS_DUMP_BUNDLE, request) as Promise<DiagnosticBundleResult>,
			openInNewWindow: (payload: IpcSessionOpenNewWindowPayload) =>
				transport.invoke(IPC_COMMANDS.SESSION_OPEN_NEW_WINDOW, payload) as Promise<boolean>,
			consumePendingOpen: () => transport.invoke(IPC_COMMANDS.SESSION_CONSUME_PENDING) as Promise<string | null>,
			hosted: () => transport.invoke(IPC_COMMANDS.HOSTED_SESSIONS) as Promise<IpcHostedSession[]>,
		},

		tabs: {
			list: () => transport.invoke(IPC_COMMANDS.GET_TABS) as Promise<IpcTabInfo[]>,
			spawn: (payload: IpcSpawnTabPayload) =>
				transport.invoke(IPC_COMMANDS.SPAWN_TAB, payload) as Promise<IpcSpawnTabResult | null>,
			close: (tabId: string) => transport.invoke(IPC_COMMANDS.CLOSE_TAB, { tabId }) as Promise<boolean>,
			setActive: async (tabId: string) => {
				const switched = await transport.invoke<boolean>(IPC_COMMANDS.SET_ACTIVE_TAB, { tabId });
				if (switched) activeTabId = tabId;
				return switched;
			},
			setView: async (
				focusedTabId: string,
				visibleTabIds: string[],
				split?: IpcSetTabViewPayload["split"],
				rememberedSplits?: IpcSetTabViewPayload["rememberedSplits"],
			) => {
				const switched = await transport.invoke<boolean>(IPC_COMMANDS.SET_TAB_VIEW, {
					focusedTabId,
					visibleTabIds,
					split,
					rememberedSplits,
				});
				if (switched) activeTabId = focusedTabId;
				return switched;
			},
			reorder: (tabIds: string[]) => transport.invoke(IPC_COMMANDS.REORDER_TABS, { tabIds }) as Promise<boolean>,
			getSessionOwner: (sessionPath: string, device?: string) =>
				transport.invoke(IPC_COMMANDS.GET_SESSION_OWNER, {
					sessionPath,
					device,
				}) as Promise<IpcSessionOwner | null>,
		},

		remote: {
			getState: () => transport.invoke(IPC_COMMANDS.REMOTE_GET_STATE) as Promise<RemoteState>,
			setHostEnabled: (enabled: boolean) =>
				transport.invoke(IPC_COMMANDS.REMOTE_SET_HOST_ENABLED, enabled) as Promise<RemoteState>,
			setDeviceName: (name: string) =>
				transport.invoke(IPC_COMMANDS.REMOTE_SET_DEVICE_NAME, name) as Promise<RemoteState>,
			setKeepAwake: (enabled: boolean) =>
				transport.invoke(IPC_COMMANDS.REMOTE_SET_KEEP_AWAKE, enabled) as Promise<RemoteState>,
			revokePeer: (deviceId: string) =>
				transport.invoke(IPC_COMMANDS.REMOTE_REVOKE_PEER, deviceId) as Promise<RemoteState>,
			blockPeer: (deviceId: string) =>
				transport.invoke(IPC_COMMANDS.REMOTE_BLOCK_PEER, deviceId) as Promise<RemoteState>,
			setPeerLimits: (deviceId: string, limits: PeerLimits) =>
				transport.invoke(IPC_COMMANDS.REMOTE_SET_PEER_LIMITS, { deviceId, limits }) as Promise<RemoteState>,
			renameHost: (deviceId: string, name: string) =>
				transport.invoke(IPC_COMMANDS.REMOTE_RENAME_HOST, { deviceId, name }) as Promise<RemoteState>,
			renamePeer: (deviceId: string, name: string) =>
				transport.invoke(IPC_COMMANDS.REMOTE_RENAME_PEER, { deviceId, name }) as Promise<RemoteState>,
			watchTailnet: (on: boolean) =>
				transport.invoke(IPC_COMMANDS.REMOTE_WATCH_TAILNET, on) as Promise<TailnetComputer[]>,
			connect: (nodeId: string) => transport.invoke(IPC_COMMANDS.REMOTE_CONNECT, nodeId) as Promise<HostView>,
			tailscaleAction: (action: "install" | "start-app") =>
				transport.invoke(IPC_COMMANDS.REMOTE_TAILSCALE_ACTION, action) as Promise<RemoteState>,
			dismissForgotten: () => transport.invoke(IPC_COMMANDS.REMOTE_DISMISS_FORGOTTEN) as Promise<RemoteState>,
			removeHost: (deviceId: string) =>
				transport.invoke(IPC_COMMANDS.REMOTE_REMOVE_HOST, deviceId) as Promise<RemoteState>,
			listDirs: (deviceId: string, path?: string, query?: string) =>
				transport.invoke(IPC_COMMANDS.REMOTE_LIST_DIRS, { deviceId, path, query }) as Promise<RemoteDirListing>,
			onState: (callback: (state: RemoteState) => void) => subscribe<RemoteState>(IPC_EVENTS.REMOTE_STATE, callback),
			onTailnet: (callback: (computers: TailnetComputer[]) => void) =>
				subscribe<TailnetComputer[]>(IPC_EVENTS.REMOTE_TAILNET, callback),
		},

		stats: {
			fetch: (path: string, params?: Record<string, string>, device?: string) =>
				transport.invoke(IPC_COMMANDS.STATS_FETCH, { path, params, device }),
		},

		bench: {
			run: (options: IpcBenchmarkRunOptions, device?: string) =>
				transport.invoke(IPC_COMMANDS.BENCH_RUN, options, device) as Promise<IpcBenchmarkRunResult>,
			abort: (device?: string) => transport.invoke(IPC_COMMANDS.BENCH_ABORT, device) as Promise<boolean>,
		},

		modelSetup: {
			run: (request: ModelSetupRequest, device?: string) =>
				transport.invoke(IPC_COMMANDS.MODEL_SETUP_RUN, request, device) as Promise<IpcModelSetupRunResult>,
			status: (device?: string) =>
				transport.invoke(IPC_COMMANDS.MODEL_SETUP_STATUS, device) as Promise<ModelSetupStatus>,
			abort: (device?: string) => transport.invoke(IPC_COMMANDS.MODEL_SETUP_ABORT, device) as Promise<boolean>,
		},

		system: {
			info: () => transport.invoke(IPC_COMMANDS.SYSTEM_INFO) as Promise<SystemInfo>,
			openExternal: (url: string) => transport.invoke(IPC_COMMANDS.SYSTEM_OPEN_EXTERNAL, url),
			openPath: (path: string, tabId?: string) =>
				transport.invoke(IPC_COMMANDS.SYSTEM_OPEN_PATH, path, tabId) as Promise<IpcOpenPathResult>,
			revealPath: (path: string, tabId?: string) =>
				transport.invoke(IPC_COMMANDS.SYSTEM_REVEAL_PATH, path, tabId) as Promise<IpcOpenPathResult>,
			showSaveDialog: (defaultPath?: string, filters?: { name: string; extensions: string[] }[]) =>
				transport.invoke(IPC_COMMANDS.SYSTEM_SAVE_DIALOG, defaultPath, filters),
			saveImage: (defaultName: string, mimeType: string, data: string) =>
				transport.invoke(IPC_COMMANDS.SYSTEM_SAVE_IMAGE, defaultName, mimeType, data),
			showOpenDialog: (
				filters?: { name: string; extensions: string[] }[],
				options?: { directory?: boolean; title?: string; buttonLabel?: string },
			) => transport.invoke(IPC_COMMANDS.SYSTEM_OPEN_DIALOG, filters, options),
			notify: (title: string, body?: string, tabId?: string, kind?: IpcNotifyKind) => {
				transport.invoke(IPC_COMMANDS.SYSTEM_NOTIFY, { title, body, tabId, kind } satisfies IpcNotifyPayload);
			},
		},

		prefs: {
			get: (key?: string) => transport.invoke(IPC_COMMANDS.PREFS_GET, { key }),
			set: (key: string, value: unknown) => transport.invoke(IPC_COMMANDS.PREFS_SET, { key, value }),
			getLaunchProfile: (cwd, device) => transport.invoke(IPC_COMMANDS.PREFS_GET_LAUNCH_PROFILE, { cwd, device }),
			updateLaunchProfile: (cwd, patch, device) =>
				transport.invoke(IPC_COMMANDS.PREFS_UPDATE_LAUNCH_PROFILE, { cwd, patch, device }),
			onChanged: callback => subscribe<IpcPrefsChangedPayload>(IPC_EVENTS.PREFS_CHANGED, callback),
		},

		sidecar: {
			restart: (payload?: IpcSidecarRestartPayload) => transport.invoke(IPC_COMMANDS.SIDECAR_RESTART, payload),
			selectProject: () => transport.invoke(IPC_COMMANDS.SIDECAR_SELECT_PROJECT),
			setProject: (cwd: string) => transport.invoke(IPC_COMMANDS.SIDECAR_SET_PROJECT, { cwd }),
			defaultWorkspace: (device?: string) =>
				transport.invoke(IPC_COMMANDS.SIDECAR_DEFAULT_WORKSPACE, device) as Promise<string>,
			getStatus: () => transport.invoke(IPC_COMMANDS.SIDECAR_STATUS_GET),
		},

		tray: {
			pushState: (state: TrayState) => transport.send(IPC_EVENTS.TRAY_STATE_PUSH, state),
		},

		progress: {
			set: (state: RunProgressState) => transport.send(IPC_EVENTS.PROGRESS_SET, state),
		},

		windowChrome: {
			setColors: colors => transport.send(IPC_EVENTS.WINDOW_CHROME_SET, colors),
		},

		models: {
			listProviders: (device?: string) =>
				transport.invoke(IPC_COMMANDS.MODELS_PROVIDERS_LIST, device) as Promise<CustomProvidersConfig>,
			signedIn: () => transport.invoke(IPC_COMMANDS.MODELS_SIGNED_IN) as Promise<boolean | null>,
			upsertProvider: (input: CustomProviderInput, device?: string) =>
				transport.invoke(IPC_COMMANDS.MODELS_PROVIDER_UPSERT, input, device) as Promise<void>,
			deleteProvider: (id: string, device?: string) =>
				transport.invoke(IPC_COMMANDS.MODELS_PROVIDER_DELETE, id, device) as Promise<void>,
			setModelOverride: (provider: string, modelId: string, override: ModelOverrideInput | null, device?: string) =>
				transport.invoke(IPC_COMMANDS.MODELS_OVERRIDE_SET, provider, modelId, override, device) as Promise<void>,
			openConfig: (device?: string) =>
				transport.invoke(IPC_COMMANDS.MODELS_CONFIG_OPEN, device) as Promise<{ path: string; opened: boolean }>,
		},

		accountRotation: {
			get: (device?: string) =>
				transport.invoke(IPC_COMMANDS.ACCOUNT_ROTATION_GET, device) as Promise<AccountRotationState>,
			set: (mode: AccountRotationMode, device?: string) =>
				transport.invoke(IPC_COMMANDS.ACCOUNT_ROTATION_SET, mode, device) as Promise<AccountRotationState>,
		},
		builtinRea: {
			get: (device?: string) => transport.invoke(IPC_COMMANDS.BUILTIN_REA_GET, device) as Promise<BuiltinReaState>,
			set: (enabled: boolean, device?: string) =>
				transport.invoke(IPC_COMMANDS.BUILTIN_REA_SET, enabled, device) as Promise<BuiltinReaState>,
		},
		hostDesktop: {
			get: (device?: string) => transport.invoke(IPC_COMMANDS.HOST_DESKTOP_GET, device) as Promise<HostDesktopState>,
			update: (action: HostUpdateAction, device?: string) =>
				transport.invoke(IPC_COMMANDS.HOST_DESKTOP_UPDATE, action, device) as Promise<HostDesktopState>,
		},

		fs: {
			list: (path?: string, maxDepth?: number, maxEntries?: number, tabId?: string) =>
				transport.invoke(IPC_COMMANDS.FS_LIST, { path, maxDepth, maxEntries, tabId }) as Promise<IpcFsListResult>,
			read: (path: string, maxBytes?: number, tabId?: string) =>
				transport.invoke(IPC_COMMANDS.FS_READ, { path, maxBytes, tabId }) as Promise<IpcFsReadResult>,
			stat: (path, tabId) => transport.invoke(IPC_COMMANDS.FS_STAT, { path, tabId }),
			mutate: (mutation, tabId) => transport.invoke(IPC_COMMANDS.FS_MUTATE, { mutation, tabId }),
			search: (request, tabId) => transport.invoke(IPC_COMMANDS.FS_SEARCH, { request, tabId }),
			readPlan: (payload: IpcFsReadPlanPayload) =>
				transport.invoke(IPC_COMMANDS.FS_READ_PLAN, payload) as Promise<IpcFsReadPlanResult>,
			readImage: (path: string, tabId?: string) =>
				transport.invoke(IPC_COMMANDS.FS_READ_IMAGE, { path, tabId }) as Promise<IpcFsReadImageResult>,
			readBinary: (path: string, maxBytes?: number, tabId?: string) =>
				transport.invoke(IPC_COMMANDS.FS_READ_BINARY, { path, maxBytes, tabId }) as Promise<IpcFsReadBinaryResult>,
			mediaStream: (path: string, tabId?: string) =>
				transport.invoke(IPC_COMMANDS.FS_MEDIA_STREAM, { path, tabId }) as Promise<IpcFsMediaStreamResult>,
			releaseMediaStream: (url: string) => transport.send(IPC_COMMANDS.FS_MEDIA_RELEASE, url),
		},

		editor: {
			openExternal: (content: string) =>
				transport.invoke(IPC_COMMANDS.EDITOR_OPEN_EXTERNAL, { content }) as Promise<{
					ok: boolean;
					unavailable: boolean;
					text: string | null;
					error?: string;
				}>,
		},

		worktreeLifecycle: {
			prompts: () => transport.invoke(IPC_COMMANDS.WORKTREE_PROMPTS_GET) as Promise<IpcWorktreePrompt[]>,
			answer: async (id: string, accept: boolean) => {
				const payload: IpcWorktreePromptAnswer = { id, accept };
				await transport.invoke(IPC_COMMANDS.WORKTREE_PROMPT_ANSWER, payload);
			},
			onPrompts: (callback: (prompts: IpcWorktreePrompt[]) => void) =>
				subscribe<IpcWorktreePrompt[]>(IPC_EVENTS.WORKTREE_PROMPTS, callback),
			onNotice: (callback: (notice: IpcWorktreeNotice) => void) =>
				subscribe<IpcWorktreeNotice>(IPC_EVENTS.WORKTREE_NOTICE, callback),
		},

		projectOrigins: {
			get: (cwds: string[]) =>
				transport.invoke(IPC_COMMANDS.PROJECT_ORIGINS_GET, cwds) as Promise<Record<string, ProjectOrigin | null>>,
		},
	};
}
