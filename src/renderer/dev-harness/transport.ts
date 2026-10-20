/**
 * The dev harness's `OmpTransport`: what the app's main process answers, from fixture state, so the renderer runs
 * as the web client does but before any server exists. `createOmpApi(transport)` is `window.omp`.
 *
 * The answers are only as deep as the layouts need: tabs and sessions, a transcript, the session's state, the
 * model list. Every other channel resolves `undefined` (or `{}` for an RPC command) and is logged to
 * `window.__harness.unhandled`, so a layout that needs more shows up there instead of failing silently.
 * `window.__harness.emit(channel, payload)` plays a main→renderer push (a tab status, a streaming batch, an ask).
 */

import { EMPTY_GITHUB_AUTH_STATE } from "../../shared/github-auth";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { MOBILE_WEB_COMMAND, MOBILE_WEB_GET_STATE, WEB_BLOCKS_LIST, WEB_DEVICES_LIST } from "../../shared/mobile-web";
import type { OmpTransport } from "../../shared/omp-api";
import {
	EMPTY_PREVIEW,
	PREVIEW_COMMAND,
	PREVIEW_STATE,
	PREVIEW_STREAM_COPY,
	PREVIEW_STREAM_DIALOG,
	PREVIEW_STREAM_POLL,
	type PreviewRequest,
	type PreviewStreamDialog,
	type PreviewStreamPoll,
	type PreviewStreamPollRequest,
} from "../../shared/preview";
import type { RpcCommand, SettingsSchemaResult } from "../../shared/rpc-types";
import { SCHEDULES_COMMAND, SCHEDULES_LOG } from "../../shared/schedules";
import type { TerminalLeaseState, TerminalOperation, TerminalSnapshot } from "../../shared/terminal-types";
import {
	ADVISOR_USAGE,
	CONTEXT_INSPECT,
	FILE_CONTENTS,
	FILE_TREE,
	GIT_CHANGES,
	GIT_DIFFS,
	MODELS,
	PR_DETAIL,
	PR_LIST,
	PR_REPO,
	PROVIDERS,
	SESSION_STATS,
	sessionsFixture,
	stateFixture,
	TERMINAL_OUTPUT,
	tabsFixture,
	transcriptFor,
} from "./fixture";
import { BOARD_BUSY, boardJobs, boardPeers, boardReview, boardSubagents, boardUsage } from "./fixture-board";
import { JOB_TREE_SUBAGENTS, jobTreeRows } from "./fixture-jobs";
import { memoryAnswer } from "./fixture-memory";
import {
	ACTIVE_TOOLS,
	DIRECTORIES,
	MARKETPLACES,
	MOBILE_WEB_STATE,
	MODEL_ROLES,
	MODEL_SETUP_FACTS,
	PLUGINS,
	PROMPT_TEMPLATES,
	REMOTE_STATE,
	RUNTIME_LOG_TAIL,
	SCHEDULE_LOG,
	SCHEDULES_STATE,
	SECURITY_DASHBOARD,
	SESSION_SPEND,
	SETUP_STATE,
	WEB_BLOCKS,
	WEB_DEVICES,
} from "./fixture-settings";
import { diskCareState, orphanWorktrees, savedWorktreeRestore, savedWorktrees } from "./fixture-work-tree";

type Listener = (data: unknown) => void;

/**
 * `?firstrun=1`: a computer with no credential, so the first-run provider step shows. The rows are stock's
 * sign-in providers (ids as `omp /login` lists them), all signed out.
 */
const FIRST_RUN = new URLSearchParams(location.search).get("firstrun") === "1";
/** `?jobs=tree`: Background tasks lists subagents' jobs nested under them (./fixture-jobs.ts). */
const JOBS_TREE = new URLSearchParams(location.search).get("jobs") === "tree";
const FIRST_RUN_PROVIDERS = [
	["anthropic", "Anthropic (Claude Pro/Max)"],
	["cerebras", "Cerebras"],
	["deepseek", "DeepSeek"],
	["github-copilot", "GitHub Copilot"],
	["google-gemini-cli", "Google Cloud Code Assist (Gemini CLI)"],
	["groq", "Groq"],
	["mistral", "Mistral"],
	["openai-codex", "ChatGPT Plus/Pro (Codex Subscription)"],
	["openrouter", "OpenRouter"],
	["xai", "xAI API"],
	["xai-oauth", "xAI Grok OAuth (SuperGrok or X Premium+)"],
].map(([id, name]) => ({ id, name, authenticated: false, loginAvailable: true, disabled: false, modelCount: 0 }));

export interface Harness {
	emit(channel: string, payload: unknown): void;
	/** Channels and commands the fixture has no answer for, in order of first call. */
	unhandled: string[];
	/** Every `invoke` and `send`, for tests that assert what the shell asked main to do. */
	calls: { channel: string; args: unknown[] }[];
	/** The streamed preview page: dialogs the page "opens" (queue one, the next poll carries it) and the answers it got. */
	stream: { dialogs: PreviewStreamDialog[]; answers: unknown[] };
	/** The terminal's PTY size lease as the host reports it: set `other` to show the lease banner. */
	terminal: { lease: TerminalLeaseState };
}

declare global {
	interface Window {
		__harness?: Harness;
	}
}

interface RpcPayload {
	command: RpcCommand;
	tabId?: string;
}

interface TabPayload {
	tabId: string;
}

interface ViewPayload {
	focusedTabId: string;
}

/** Channels whose answer the renderer iterates: an empty list, not `undefined`. */
const EMPTY_LISTS = [
	IPC_COMMANDS.EXTENSION_UI_OPEN,
	IPC_COMMANDS.HOSTED_SESSIONS,
	"worktree-lifecycle:prompts-get",
	"ssh-tools:prompts",
];

/** A stock-shaped settings list (`get_settings_schema`): a few rows so a settings page shows its real layout. */
const SETTINGS_SCHEMA: SettingsSchemaResult = {
	tabs: [
		{ id: "agent", label: "Agent", groups: ["Behavior"] },
		{ id: "tools", label: "Tools", groups: ["Approvals"] },
	],
	entries: [
		{
			path: "defaultThinkingLevel",
			type: "enum",
			value: "auto",
			default: "high",
			label: "Thinking level",
			description: "How hard the model thinks before it answers.",
			tab: "agent",
			group: "Behavior",
			options: [
				{ value: "auto", label: "Auto" },
				{ value: "high", label: "High" },
				{ value: "low", label: "Low" },
			],
		},
		{
			path: "compaction.enabled",
			type: "boolean",
			value: true,
			default: true,
			label: "Compact long sessions",
			description: "Summarise older turns when the context fills up.",
			tab: "agent",
			group: "Behavior",
		},
		{
			path: "tools.approvalMode",
			type: "enum",
			value: "ask",
			default: "ask",
			label: "Approval mode",
			description: "When the agent asks before it runs a tool.",
			tab: "tools",
			group: "Approvals",
			options: [
				{ value: "ask", label: "Ask" },
				{ value: "auto", label: "Auto" },
			],
		},
	],
};

interface PrefsGetPayload {
	key?: string;
}

interface PrefsSetPayload {
	key: string;
	value: unknown;
}

export function createHarnessTransport(prefs: Record<string, unknown>): { transport: OmpTransport; harness: Harness } {
	const listeners = new Map<string, Set<Listener>>();
	const unhandled: string[] = [];
	const calls: Harness["calls"] = [];
	let activeTabId = "tab-1";
	const note = (key: string) => {
		if (!unhandled.includes(key)) unhandled.push(key);
	};

	const respond = (command: RpcCommand, data: unknown = {}) => ({
		type: "response" as const,
		command: command.type,
		success: true as const,
		data,
	});

	const rpc = ({ command, tabId = activeTabId }: RpcPayload) => {
		switch (command.type) {
			case "get_state":
				return respond(command, stateFixture(tabId));
			case "get_transcript_page": {
				const messages = FIRST_RUN ? [] : transcriptFor(tabId);
				return respond(command, { messages, totalMessages: messages.length });
			}
			case "get_transcript":
				return respond(command, { messages: FIRST_RUN ? [] : transcriptFor(tabId) });
			case "get_delegation":
			case "set_delegation":
				return respond(command, { mode: "assisted" });
			case "get_available_models":
			case "get_providers":
				return respond(command, {
					models: FIRST_RUN ? [] : MODELS,
					providers: FIRST_RUN ? FIRST_RUN_PROVIDERS : PROVIDERS,
					discoveryStates: [],
					refreshPending: false,
					generation: 1,
				});
			case "history_recent":
				return respond(command, []);
			case "get_settings_schema":
				return respond(command, SETTINGS_SCHEMA);
			case "get_settings":
				return respond(command, {
					values: {
						...Object.fromEntries(SETTINGS_SCHEMA.entries.map(entry => [entry.path, entry.value])),
						// The Run sheet's Context rows read these two (ContextSizeField).
						extendedContext: false,
						"compaction.modelThresholds": {},
					},
				});
			case "get_model_roles":
				return respond(command, MODEL_ROLES);
			case "get_model_setup_facts":
				return respond(command, MODEL_SETUP_FACTS);
			case "get_session_spend":
				return respond(command, SESSION_SPEND);
			case "get_plugins":
				return respond(command, PLUGINS);
			case "get_marketplaces":
				return respond(command, MARKETPLACES);
			case "get_prompt_templates":
				return respond(command, PROMPT_TEMPLATES);
			case "get_active_tools":
				return respond(command, ACTIVE_TOOLS);
			case "get_security_dashboard":
				return respond(command, SECURITY_DASHBOARD);
			case "get_directories":
				return respond(command, DIRECTORIES);
			case "get_ssh_hosts":
				return respond(command, { openSshAvailable: true, hosts: [], warnings: [] });
			case "get_available_commands":
				return respond(command, { commands: [] });
			case "get_subagents":
				return respond(command, {
					subagents: BOARD_BUSY ? boardSubagents() : JOBS_TREE ? JOB_TREE_SUBAGENTS : [],
				});
			case "get_jobs":
				return respond(command, { rows: BOARD_BUSY ? boardJobs() : JOBS_TREE ? jobTreeRows() : [] });
			case "get_queue":
				return respond(command, { steering: [], followUp: [] });
			case "agent_control_review":
				return respond(command, BOARD_BUSY ? boardReview() : { items: [] });
			case "get_usage":
				return respond(command, BOARD_BUSY ? boardUsage() : { reports: [] });
			case "get_orphan_worktrees":
				return respond(command, orphanWorktrees());
			case "remove_orphan_worktree":
				return respond(command, { removal: "removed" });
			case "get_saved_worktrees":
				return respond(command, savedWorktrees());
			case "restore_saved_worktree":
				return respond(command, savedWorktreeRestore());
			case "get_git_fingerprint":
				return respond(command, { fingerprint: "harness" });
			case "get_git_changes":
				return respond(command, GIT_CHANGES);
			case "get_git_unlanded":
				// The harness session works on its own branch: "Not in main yet" lists the changed files.
				return respond(command, {
					branch: "omp/agent/sidebar-flake",
					target: "main",
					files: GIT_CHANGES.files,
					truncated: false,
				});
			case "get_checkout_peers":
				return respond(command, BOARD_BUSY ? boardPeers() : { peers: null });
			case "get_git_diff": {
				const { path } = command;
				return respond(command, { path, diff: GIT_DIFFS[path] ?? "", kind: "text", truncated: false });
			}
			case "get_session_stats":
				return respond(command, SESSION_STATS);
			case "get_advisor_stats":
				return respond(command, ADVISOR_USAGE);
			case "get_context_inspect":
				return respond(command, CONTEXT_INSPECT);
			case "get_desktop_slot":
				return respond(command, { holder: null, queue: [] });
			case "pr_comments":
				return respond(command, { entries: [] });
			case "github":
				// The GitHub center: one host, the checkout's repository, and no rows in any list.
				return respond(
					command,
					command.request.op === "hosts"
						? { hosts: ["github.com"], repo: PR_REPO.repo }
						: command.request.op.endsWith("_list")
							? []
							: {},
				);
			case "pr_repo":
				return respond(command, PR_REPO);
			case "pr_list":
				return respond(command, PR_LIST);
			case "pr_get":
				return respond(command, PR_DETAIL);
			default:
				note(`rpc:${command.type}`);
				return respond(command);
		}
	};

	const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
		calls.push({ channel, args });
		// Each case reads the one payload shape its channel carries.
		const payload: unknown = args[0];
		const memory = memoryAnswer(channel, args);
		if (memory) return memory.value;
		switch (channel) {
			case IPC_COMMANDS.GET_TABS:
				return tabsFixture();
			case IPC_COMMANDS.SET_ACTIVE_TAB:
				activeTabId = (payload as TabPayload).tabId;
				return true;
			case IPC_COMMANDS.SET_TAB_VIEW:
				activeTabId = (payload as ViewPayload).focusedTabId;
				return true;
			case IPC_COMMANDS.RPC_COMMAND:
				return rpc({ command: (payload as RpcPayload).command });
			case IPC_COMMANDS.RPC_COMMAND_FOR_TAB:
				return rpc(payload as RpcPayload);
			case IPC_COMMANDS.SESSIONS_LIST:
				return sessionsFixture();
			case IPC_COMMANDS.PREFS_GET: {
				const request = payload as PrefsGetPayload | undefined;
				return request?.key === undefined ? prefs : prefs[request.key];
			}
			case IPC_COMMANDS.PREFS_SET: {
				const request = payload as PrefsSetPayload;
				prefs[request.key] = request.value;
				return undefined;
			}
			case IPC_COMMANDS.SYSTEM_INFO:
				return {
					appVersion: "0.0.0-harness",
					platform: "web",
					arch: "arm64",
					deviceLanguage: "en",
					osRelease: "",
					electron: "",
					chrome: "",
					node: "",
				};
			case IPC_COMMANDS.UPDATER_GET_STATUS:
				return { state: "idle" };
			case IPC_COMMANDS.DISK_CARE_GET_STATE:
			case IPC_COMMANDS.DISK_CARE_RUN:
				return diskCareState();
			case IPC_COMMANDS.UPDATER_CHECK:
				return { state: "not-available", version: "0.0.0-harness" };
			case IPC_COMMANDS.LOG_SNAPSHOT:
				return {
					lines: [
						"2026-10-19T09:12:03.104Z INFO  sidecar ready (omp 18.12.2)",
						"2026-10-19T09:12:04.551Z WARN  retrying request after 529 overloaded",
						"2026-10-19T09:12:09.020Z ERROR tool bash exited 1: test failed",
					],
					nextSequence: 3,
				};
			case IPC_COMMANDS.RUNTIME_LOG_TAIL:
				return RUNTIME_LOG_TAIL;
			case IPC_COMMANDS.MODELS_SIGNED_IN:
				return !FIRST_RUN;
			case IPC_COMMANDS.GITHUB_AUTH_REFRESH:
				return EMPTY_GITHUB_AUTH_STATE;
			case IPC_COMMANDS.MODELS_PROVIDERS_LIST:
				return { providers: [] };
			case IPC_COMMANDS.SETUP_GET_STATE:
				return SETUP_STATE;
			case IPC_COMMANDS.REMOTE_GET_STATE:
				return REMOTE_STATE;
			case SCHEDULES_COMMAND:
				return SCHEDULES_STATE;
			case SCHEDULES_LOG:
				return SCHEDULE_LOG;
			case MOBILE_WEB_GET_STATE:
			case MOBILE_WEB_COMMAND:
				return MOBILE_WEB_STATE;
			case WEB_DEVICES_LIST:
				return WEB_DEVICES;
			case WEB_BLOCKS_LIST:
				return WEB_BLOCKS;
			case "ssh-tools:command":
				return { forwards: [], watches: [], graceMs: 60 * 60_000 };
			case "ssh-tools:agent":
				return { agent: "none", agentKeys: [], keyFiles: [], keygen: false };
			case IPC_COMMANDS.FS_LIST:
				return { ok: true, entries: FILE_TREE, truncated: false };
			case IPC_COMMANDS.FS_READ: {
				const path = (payload as { path: string }).path;
				const content = FILE_CONTENTS[path];
				if (content === undefined) return { ok: false, content: "", truncated: false, binary: false, size: 0 };
				return { ok: true, content, truncated: false, binary: false, size: content.length };
			}
			case IPC_COMMANDS.FS_STAT:
				return { ok: true, mtimeMs: 1, size: 1 };
			case PREVIEW_COMMAND: {
				const request = payload as PreviewRequest;
				if (request.action === "load") {
					harness.emit(PREVIEW_STATE, {
						...EMPTY_PREVIEW,
						url: request.url,
						title: "Harness page",
						tabs: [{ id: "page-1", title: "Harness page", url: request.url, loading: false }],
						activeTab: "page-1",
					});
				}
				return undefined;
			}
			case PREVIEW_STREAM_POLL:
				return streamPoll(payload as PreviewStreamPollRequest);
			case PREVIEW_STREAM_DIALOG:
				harness.stream.answers.push(payload);
				return undefined;
			case PREVIEW_STREAM_COPY:
				return "selected on the page";
			case "terminal:shells":
				return [];
			case "terminal:request":
				return terminalRequest(args[1] as TerminalOperation);
			default:
				if (EMPTY_LISTS.includes(channel)) return [];
				note(channel);
				return undefined;
		}
	};

	/** One JPEG of the harness page, drawn once (a canvas is the one encoder a browser has). */
	let frameJpeg: string | undefined;
	const jpeg = () => {
		if (frameJpeg) return frameJpeg;
		const canvas = document.createElement("canvas");
		canvas.width = 390;
		canvas.height = 600;
		const context = canvas.getContext("2d");
		if (context) {
			context.fillStyle = "#0b3d91";
			context.fillRect(0, 0, 390, 600);
			context.fillStyle = "#ffffff";
			context.font = "28px sans-serif";
			context.fillText("Page on the computer", 24, 80);
		}
		frameJpeg = canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "";
		return frameJpeg;
	};
	let frameSeq = 0;
	const streamPoll = async (request: PreviewStreamPollRequest): Promise<PreviewStreamPoll> => {
		const deadline = Date.now() + 700;
		// The first poll (or one after a reconnect) is answered with a frame; the rest wait for a dialog.
		for (;;) {
			const dialogs = harness.stream.dialogs.splice(0);
			if (request.ack === null || dialogs.length > 0 || Date.now() > deadline) {
				const frame =
					request.ack === null
						? {
								seq: ++frameSeq,
								tab: "page-1",
								width: 390,
								height: 600,
								rect: { x: 0, y: 0, width: 390, height: 600 },
								jpeg: jpeg(),
							}
						: null;
				return { frame, dialogs };
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	};
	let terminalSent = false;
	const terminalRequest = async (operation: TerminalOperation): Promise<TerminalSnapshot[]> => {
		const snapshot = (output: string, offset: number): TerminalSnapshot => ({
			id: "term-1",
			output,
			offset,
			exited: false,
			cols: 60,
			rows: 20,
			lease: harness.terminal.lease,
		});
		if (operation.action === "claim") harness.terminal.lease = "you";
		if (operation.action === "list" && operation.waitMs) {
			if (!terminalSent) {
				terminalSent = true;
				return [snapshot(TERMINAL_OUTPUT, TERMINAL_OUTPUT.length)];
			}
			await new Promise(resolve => setTimeout(resolve, 400));
			return [snapshot("", TERMINAL_OUTPUT.length)];
		}
		return [snapshot("", operation.action === "list" && operation.offsets?.["term-1"] ? TERMINAL_OUTPUT.length : 0)];
	};

	const harness: Harness = {
		emit(channel, data) {
			for (const listener of listeners.get(channel) ?? []) listener(data);
		},
		unhandled,
		calls,
		stream: { dialogs: [], answers: [] },
		terminal: { lease: "you" },
	};

	const transport: OmpTransport = {
		invoke: invoke as OmpTransport["invoke"],
		send(channel, ...args) {
			calls.push({ channel, args });
		},
		on(channel, listener) {
			const set = listeners.get(channel) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(channel, set);
			return () => set.delete(listener);
		},
	};
	return { transport, harness };
}
