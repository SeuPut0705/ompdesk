/**
 * Every IPC channel, classified for the paired web client: its direction, the permission a call needs
 * (`WebPermission`), and how a web page gets it. `IPC_POLICY` is typed over the whole channel union, so a
 * new channel does not compile until it is classified here, and a `web` or `transform`/`client` entry has
 * to say what the web side does instead (`web`). ipc-policy.test.ts checks the table against the handlers
 * main registers and the push channels the renderer listens to.
 *
 * Modes, renderer → main: `pass` = the handler serves a web caller as it is; `web` = the page gets a web
 * counterpart; `boundary` = refused for a web device. Main → renderer: `pass` = the payload goes out
 * unchanged; `transform` = the host rewrites it for a web page; `client` = the page makes it itself.
 */
import { AGENT_CONTROL_REVIEW, AGENT_CONTROL_VIEW } from "../../shared/agent-control";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import {
	MOBILE_WEB_COMMAND,
	MOBILE_WEB_GET_STATE,
	MOBILE_WEB_STATE,
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
} from "../../shared/mobile-web";
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
} from "../../shared/preview";
import { SCHEDULES_COMMAND, SCHEDULES_LOG, SCHEDULES_STATE } from "../../shared/schedules";
import {
	SSH_TOOLS_AGENT,
	SSH_TOOLS_COMMAND,
	SSH_TOOLS_PROMPT,
	SSH_TOOLS_PROMPTS,
	SSH_TOOLS_STATE,
} from "../../shared/ssh-tools";
import type { WebPermission } from "../../shared/web-protocol";

/** Every channel between a page and main. */
export type IpcChannel =
	| (typeof IPC_COMMANDS)[keyof typeof IPC_COMMANDS]
	| (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]
	| typeof PREVIEW_COMMAND
	| typeof PREVIEW_SAVE_PDF
	| typeof PREVIEW_PAGE
	| typeof PREVIEW_VISUALS
	| typeof PREVIEW_STREAM_POLL
	| typeof PREVIEW_STREAM_INPUT
	| typeof PREVIEW_STREAM_DIALOG
	| typeof PREVIEW_STREAM_COPY
	| typeof PREVIEW_STREAM_PDF
	| typeof PREVIEW_STATE
	| typeof PREVIEW_VISUAL
	| typeof SCHEDULES_COMMAND
	| typeof SCHEDULES_LOG
	| typeof SCHEDULES_STATE
	| typeof SSH_TOOLS_COMMAND
	| typeof SSH_TOOLS_AGENT
	| typeof SSH_TOOLS_PROMPTS
	| typeof SSH_TOOLS_STATE
	| typeof SSH_TOOLS_PROMPT
	| typeof MOBILE_WEB_GET_STATE
	| typeof MOBILE_WEB_COMMAND
	| typeof MOBILE_WEB_STATE
	| typeof WEB_DEVICES_LIST
	| typeof WEB_DEVICES_REVOKE
	| typeof WEB_DEVICES_RENAME
	| typeof WEB_DEVICES_SET_GRANTS
	| typeof WEB_DEVICES_SET_LIMITS
	| typeof WEB_BLOCKS_LIST
	| typeof WEB_BLOCKS_REMOVE
	| typeof WEB_DEVICES_CHANGED
	| typeof WEB_DEVICE_CONNECTED
	| typeof WEB_PAIRING_REQUEST
	| typeof WEB_PAIRING_RESPOND
	| "terminal:shells"
	| "terminal:request"
	| typeof AGENT_CONTROL_VIEW
	| typeof AGENT_CONTROL_REVIEW;

type RequestDirection = "invoke" | "send";

export type ChannelPolicy =
	| { dir: RequestDirection; permission: WebPermission; mode: "pass" }
	| { dir: RequestDirection; permission: WebPermission; mode: "web"; web: string }
	| { dir: RequestDirection; permission: "pairing-admin"; mode: "boundary" }
	| { dir: "push"; mode: "pass" }
	| { dir: "push"; mode: "transform" | "client"; web: string };

const C = IPC_COMMANDS;
const E = IPC_EVENTS;

export const IPC_POLICY: Record<IpcChannel, ChannelPolicy> = {
	// Runtime, logs, app.
	[C.RUNTIME_ERROR_REPORT]: { dir: "send", permission: "workspace", mode: "pass" },
	[C.RUNTIME_LOG_PATH]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.RUNTIME_LOG_TAIL]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.DIAGNOSTICS_BUILD]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.RUNTIME_STARTUP_MARK]: { dir: "send", permission: "workspace", mode: "pass" },
	[C.LOG_SNAPSHOT]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.APP_QUIT]: {
		dir: "send",
		permission: "host-admin",
		mode: "web",
		web: "Restart or quit from a confirmation sheet that counts the running turns",
	},
	[C.BRIDGE_HEALTH_TAKE]: { dir: "invoke", permission: "workspace", mode: "pass" },

	// Sessions and their tabs.
	[C.RPC_COMMAND]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.RPC_COMMAND_FOR_TAB]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.EXTENSION_UI_RESPOND]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.EXTENSION_UI_OPEN]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SESSIONS_LIST]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SESSIONS_DELETE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SESSIONS_RENAME]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SESSIONS_SEARCH]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SESSIONS_MOVE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SESSION_OPEN_NEW_WINDOW]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "Open as a new tab on this device (a web page is one window)",
	},
	[C.SESSION_CONSUME_PENDING]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "The session a link or notification named rides the page's own URL",
	},
	[C.SPAWN_TAB]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.CLOSE_TAB]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SET_ACTIVE_TAB]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SET_TAB_VIEW]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.REORDER_TABS]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.GET_TABS]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.GET_SESSION_OWNER]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.WORKTREE_PROMPTS_GET]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.WORKTREE_PROMPT_ANSWER]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.PROJECT_ORIGINS_GET]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.RESUME_CANCEL_WAIT]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.RESUME_STOP]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.CONNECTIVITY_REPORT]: {
		dir: "send",
		permission: "workspace",
		mode: "web",
		web: "Not sent: the phone's link is not the host's; the page shows its own reconnect banner",
	},

	// Usage, benchmarks, model setup.
	[C.STATS_FETCH]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.BENCH_RUN]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.BENCH_ABORT]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.MODEL_SETUP_RUN]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.MODEL_SETUP_STATUS]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.MODEL_SETUP_ABORT]: { dir: "invoke", permission: "workspace", mode: "pass" },

	// The host's own desktop.
	[C.SYSTEM_INFO]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SYSTEM_OPEN_EXTERNAL]: {
		dir: "invoke",
		permission: "desktop-control",
		mode: "web",
		web: "Open on the phone; 'Open on computer' calls this handler",
	},
	[C.SYSTEM_OPEN_PATH]: {
		dir: "invoke",
		permission: "desktop-control",
		mode: "web",
		web: "Action sheet: view on the phone, download, or open on the computer through this handler",
	},
	[C.SYSTEM_REVEAL_PATH]: {
		dir: "invoke",
		permission: "desktop-control",
		mode: "web",
		web: "Go to the file in the Files panel; 'Show on computer' calls this handler",
	},
	[C.SYSTEM_SAVE_DIALOG]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "Save to the phone, or pick a host folder in the in-app browser",
	},
	[C.SYSTEM_SAVE_IMAGE]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "Save or share on the phone, or pick a host folder in the in-app browser",
	},
	[C.SYSTEM_OPEN_DIALOG]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "In-app host folder and file browser; files from the phone upload",
	},
	[C.SYSTEM_NOTIFY]: {
		dir: "invoke",
		permission: "device-self",
		mode: "web",
		web: "In-page toast or the service worker's notification; the host's OS notification only on request",
	},
	[E.TRAY_STATE_PUSH]: {
		dir: "send",
		permission: "device-self",
		mode: "web",
		web: "App badge and document title",
	},
	[E.PROGRESS_SET]: { dir: "send", permission: "device-self", mode: "web", web: "Top progress bar and app badge" },
	[E.WINDOW_CHROME_SET]: { dir: "send", permission: "device-self", mode: "web", web: "<meta name=theme-color>" },
	[C.EDITOR_OPEN_EXTERNAL]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "Full-screen in-app editor; 'Edit on computer' calls this handler",
	},

	// Preferences and models.
	[C.PREFS_GET]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "Secret keys removed; the page's shim reads this device's appearance and layout keys (shared/device-prefs.ts) from web:device.uiPrefs.get instead of the host's and overlays them",
	},
	[C.PREFS_SET]: {
		dir: "invoke",
		permission: "settings-write",
		mode: "web",
		web: "Appearance and layout keys (shared/device-prefs.ts) are written by the page's shim to web:device.uiPrefs.set and never reach here; other keys write here and push PREFS_CHANGED",
	},
	[C.PREFS_GET_LAUNCH_PROFILE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.PREFS_UPDATE_LAUNCH_PROFILE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.MODELS_PROVIDERS_LIST]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.MODELS_SIGNED_IN]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.MODELS_PROVIDER_UPSERT]: { dir: "invoke", permission: "settings-write", mode: "pass" },
	[C.MODELS_PROVIDER_DELETE]: { dir: "invoke", permission: "settings-write", mode: "pass" },
	[C.MODELS_OVERRIDE_SET]: { dir: "invoke", permission: "settings-write", mode: "pass" },
	[C.MODELS_CONFIG_OPEN]: {
		dir: "invoke",
		permission: "settings-write",
		mode: "web",
		web: "In-app YAML editor checked by the models.yml parser; 'Open on computer' calls this handler",
	},
	[C.ACCOUNT_ROTATION_GET]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.ACCOUNT_ROTATION_SET]: { dir: "invoke", permission: "accounts-admin", mode: "pass" },
	[C.BUILTIN_REA_GET]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.BUILTIN_REA_SET]: { dir: "invoke", permission: "settings-write", mode: "pass" },

	// The tab's project and files.
	[C.SIDECAR_RESTART]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SIDECAR_STATUS_GET]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SIDECAR_SELECT_PROJECT]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "In-app host folder browser, then SIDECAR_SET_PROJECT",
	},
	[C.SIDECAR_SET_PROJECT]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SIDECAR_DEFAULT_WORKSPACE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.FS_LIST]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.FS_READ]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.FS_STAT]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.FS_MUTATE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.FS_SEARCH]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.FS_READ_PLAN]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.FS_READ_IMAGE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.FS_READ_BINARY]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "Large files come over a /blob URL with range requests",
	},
	[C.FS_MEDIA_STREAM]: { dir: "invoke", permission: "workspace", mode: "web", web: "A /blob URL with range requests" },
	[C.FS_MEDIA_RELEASE]: { dir: "send", permission: "workspace", mode: "web", web: "Releases the /blob URL" },
	"terminal:shells": { dir: "invoke", permission: "workspace", mode: "pass" },
	"terminal:request": {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "Long-polled output with the mobile key bar and a size lease",
	},
	[PREVIEW_COMMAND]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "An offscreen page streamed as frames, with touch and keyboard input",
	},
	[PREVIEW_SAVE_PDF]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "Save to the phone, or pick a host folder in the in-app browser",
	},
	[PREVIEW_PAGE]: { dir: "invoke", permission: "workspace", mode: "web", web: "Runs on the streamed offscreen page" },
	[PREVIEW_VISUALS]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[PREVIEW_STREAM_POLL]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "Acknowledges the last JPEG frame and waits for the next; nothing is sent before the ack, at most 12 a second",
	},
	[PREVIEW_STREAM_INPUT]: {
		dir: "send",
		permission: "workspace",
		mode: "web",
		web: "Taps, scrolls, drags, pinch, keys and committed text become mouse, wheel and key events on the offscreen page",
	},
	[PREVIEW_STREAM_DIALOG]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "The phone answers the page's alert, confirm or prompt",
	},
	[PREVIEW_STREAM_COPY]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "The page's selected text for the phone's own clipboard",
	},
	[PREVIEW_STREAM_PDF]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "The page as a PDF for the phone to keep",
	},

	// Updates and setup of the host.
	[C.UPDATER_CHECK]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.UPDATER_DOWNLOAD]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.UPDATER_APPLY]: {
		dir: "invoke",
		permission: "host-admin",
		mode: "web",
		web: "Confirmation sheet on the phone, then a reconnect after the restart",
	},
	[C.UPDATER_POSTPONE]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.UPDATER_INSTALL_MODE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.UPDATER_GET_STATUS]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.UPDATER_VERSION]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.UPDATER_AUTH_INFO]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.UPDATER_AUTH_TEST]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.UPDATER_AUTH_SAVE]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.UPDATER_AUTH_CLEAR]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.SETUP_GET_STATE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.SETUP_RETRY]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.SETUP_CANCEL]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.OMP_UPDATE_GET_STATE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.OMP_UPDATE_NOW]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.HOST_OMP_UPDATE_GET]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.HOST_OMP_UPDATE_NOW]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.HOST_DESKTOP_GET]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.HOST_DESKTOP_UPDATE]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.CLI_UPDATE_GET_STATE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.CLI_UPDATE_NOW]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.AI_MEMORY_GET_STATE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.AI_MEMORY_SET_ENABLED]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.AI_MEMORY_RETRY]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.AI_MEMORY_PURGE]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.AI_MEMORY_SET_TERMINAL]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.AI_MEMORY_OPEN_WEB]: { dir: "invoke", permission: "desktop-control", mode: "pass" },
	[C.AI_MEMORY_COPY_WEB_PASSWORD]: { dir: "invoke", permission: "desktop-control", mode: "pass" },
	[C.AI_MEMORY_REVEAL_DATA]: { dir: "invoke", permission: "desktop-control", mode: "pass" },
	[C.AI_MEMORY_PROJECTS]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.AI_MEMORY_SEARCH]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.AI_MEMORY_RECENT]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.AI_MEMORY_HANDOFFS]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.AI_MEMORY_READ_PAGE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.EXTENSION_UPDATE_GET_STATE]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.EXTENSION_UPDATE_NOW]: { dir: "invoke", permission: "extensions-admin", mode: "pass" },
	[SCHEDULES_COMMAND]: { dir: "invoke", permission: "extensions-admin", mode: "pass" },
	[SCHEDULES_LOG]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[SSH_TOOLS_COMMAND]: { dir: "invoke", permission: "extensions-admin", mode: "pass" },
	[SSH_TOOLS_AGENT]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[SSH_TOOLS_PROMPTS]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[MOBILE_WEB_GET_STATE]: { dir: "invoke", permission: "device-self", mode: "pass" },
	[MOBILE_WEB_COMMAND]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },
	[WEB_DEVICES_LIST]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },
	[WEB_DEVICES_REVOKE]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },
	[WEB_DEVICES_RENAME]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },
	[WEB_DEVICES_SET_GRANTS]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },
	[WEB_DEVICES_SET_LIMITS]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },
	[WEB_BLOCKS_LIST]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },
	[WEB_BLOCKS_REMOVE]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },
	[WEB_PAIRING_RESPOND]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },

	// GitHub sign-in on the host.
	[C.GITHUB_AUTH_REFRESH]: { dir: "invoke", permission: "workspace", mode: "pass" },
	[C.GITHUB_AUTH_LOGIN_START]: { dir: "invoke", permission: "accounts-admin", mode: "pass" },
	[C.GITHUB_AUTH_LOGIN_OPEN]: { dir: "invoke", permission: "accounts-admin", mode: "pass" },
	[C.GITHUB_AUTH_LOGIN_CANCEL]: { dir: "invoke", permission: "accounts-admin", mode: "pass" },
	[C.GITHUB_AUTH_LOGOUT]: { dir: "invoke", permission: "accounts-admin", mode: "pass" },
	[C.GITHUB_AUTH_SWITCH]: { dir: "invoke", permission: "accounts-admin", mode: "pass" },
	[C.GITHUB_AUTH_FILL_IDENTITY]: { dir: "invoke", permission: "accounts-admin", mode: "pass" },
	[C.GITHUB_PRODUCT_STAR]: { dir: "invoke", permission: "accounts-admin", mode: "pass" },

	// Desktop-to-desktop remote devices.
	[C.REMOTE_GET_STATE]: {
		dir: "invoke",
		permission: "workspace",
		mode: "web",
		web: "The pairing code and key fields removed",
	},
	[C.REMOTE_SET_HOST_ENABLED]: {
		dir: "invoke",
		permission: "host-admin",
		mode: "web",
		web: "Turning it on waits for a confirmation on the computer",
	},
	[C.REMOTE_SET_DEVICE_NAME]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.REMOTE_SET_KEEP_AWAKE]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.REMOTE_ROTATE_CODE]: { dir: "invoke", permission: "pairing-admin", mode: "boundary" },
	[C.REMOTE_REVOKE_PEER]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.REMOTE_SET_PEER_LIMITS]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.REMOTE_DISCOVER]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.REMOTE_PAIR]: {
		dir: "invoke",
		permission: "host-admin",
		mode: "web",
		web: "Waits for a confirmation on the computer",
	},
	[C.REMOTE_REMOVE_HOST]: { dir: "invoke", permission: "host-admin", mode: "pass" },
	[C.REMOTE_LIST_DIRS]: { dir: "invoke", permission: "workspace", mode: "pass" },

	// Main → renderer.
	[E.EVENTS_BATCH]: { dir: "push", mode: "pass" },
	[E.SIDECAR_STATUS]: { dir: "push", mode: "pass" },
	[E.TAB_STATUS]: { dir: "push", mode: "pass" },
	[E.TAB_LIST_CHANGED]: { dir: "push", mode: "pass" },
	[E.EXTENSION_UI]: { dir: "push", mode: "pass" },
	[E.SIGN_IN_ENDED]: { dir: "push", mode: "pass" },
	[E.SUBAGENT_FRAMES]: { dir: "push", mode: "pass" },
	[E.COMMANDS_UPDATE]: { dir: "push", mode: "pass" },
	[E.CONFIG_UPDATE]: { dir: "push", mode: "pass" },
	[E.PROMPT_RESULT]: { dir: "push", mode: "pass" },
	[E.COMMAND_OUTPUT]: { dir: "push", mode: "pass" },
	[E.SESSION_INFO_UPDATE]: { dir: "push", mode: "pass" },
	[E.EXTENSION_ERROR]: { dir: "push", mode: "pass" },
	[E.LIVE_FRAME]: { dir: "push", mode: "pass" },
	[E.BTW_FRAME]: { dir: "push", mode: "pass" },
	[E.MODEL_CATALOG_UPDATE]: { dir: "push", mode: "pass" },
	[E.SESSIONS_CHANGED]: { dir: "push", mode: "pass" },
	[E.LOG_LINE]: { dir: "push", mode: "pass" },
	[E.MENU_ACTION]: {
		dir: "push",
		mode: "client",
		web: "The More sheet and the command palette raise the same actions on the page",
	},
	[E.DEEP_LINK]: { dir: "push", mode: "client", web: "omp:// links and the page's #/open URL route on the page" },
	[E.NOTIFICATION_CLICK]: {
		dir: "push",
		mode: "client",
		web: "The service worker's notification click opens the page at the tab",
	},
	[E.UPDATER_STATUS]: { dir: "push", mode: "pass" },
	[E.BRIDGE_HEALTH]: { dir: "push", mode: "pass" },
	[E.REMOTE_STATE]: { dir: "push", mode: "transform", web: "The pairing code and key fields removed" },
	[E.REMOTE_DISCOVERED]: { dir: "push", mode: "pass" },
	[E.WORKTREE_PROMPTS]: { dir: "push", mode: "pass" },
	[E.WORKTREE_NOTICE]: { dir: "push", mode: "pass" },
	[E.SETUP_STATE]: { dir: "push", mode: "pass" },
	[E.OMP_UPDATE_STATE]: { dir: "push", mode: "pass" },
	[E.OMP_UPDATED]: { dir: "push", mode: "pass" },
	[E.HOST_OMP_UPDATE_STATE]: { dir: "push", mode: "pass" },
	[E.CLI_UPDATE_STATE]: { dir: "push", mode: "pass" },
	[E.AI_MEMORY_STATE]: { dir: "push", mode: "pass" },
	[E.EXTENSION_UPDATE_STATE]: { dir: "push", mode: "pass" },
	[E.GITHUB_AUTH_STATE]: { dir: "push", mode: "pass" },
	[E.PREFS_CHANGED]: {
		dir: "push",
		mode: "transform",
		web: "The page's shim drops the keys this device keeps for itself (shared/device-prefs.ts)",
	},
	[PREVIEW_STATE]: { dir: "push", mode: "transform", web: "The streamed page's state for this device" },
	[PREVIEW_VISUAL]: { dir: "push", mode: "pass" },
	[SCHEDULES_STATE]: { dir: "push", mode: "pass" },
	[SSH_TOOLS_STATE]: { dir: "push", mode: "pass" },
	[SSH_TOOLS_PROMPT]: { dir: "push", mode: "pass" },
	[MOBILE_WEB_STATE]: { dir: "push", mode: "pass" },
	[WEB_DEVICES_CHANGED]: { dir: "push", mode: "transform", web: "Sent to desktop windows only" },
	[WEB_DEVICE_CONNECTED]: { dir: "push", mode: "transform", web: "Sent to desktop windows only" },
	[WEB_PAIRING_REQUEST]: { dir: "push", mode: "transform", web: "Sent to desktop windows only" },
	[AGENT_CONTROL_VIEW]: { dir: "push", mode: "pass" },
	[AGENT_CONTROL_REVIEW]: { dir: "push", mode: "pass" },
};
