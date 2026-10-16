/**
 * The dev harness's `OmpTransport`: what the app's main process answers, from fixture state, so the renderer runs
 * as the web client does but before any server exists. `createOmpApi(transport)` is `window.omp`.
 *
 * The answers are only as deep as the layouts need: tabs and sessions, a transcript, the session's state, the
 * model list. Every other channel resolves `undefined` (or `{}` for an RPC command) and is logged to
 * `window.__harness.unhandled`, so a layout that needs more shows up there instead of failing silently.
 * `window.__harness.emit(channel, payload)` plays a main→renderer push (a tab status, a streaming batch, an ask).
 */

import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { OmpTransport } from "../../shared/omp-api";
import type { RpcCommand } from "../../shared/rpc-types";
import { GIT_CHANGES, MODELS, PROVIDERS, sessionsFixture, stateFixture, tabsFixture, transcriptFor } from "./fixture";

type Listener = (data: unknown) => void;

export interface Harness {
	emit(channel: string, payload: unknown): void;
	/** Channels and commands the fixture has no answer for, in order of first call. */
	unhandled: string[];
	/** Every `invoke` and `send`, for tests that assert what the shell asked main to do. */
	calls: { channel: string; args: unknown[] }[];
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
const EMPTY_LISTS = [IPC_COMMANDS.EXTENSION_UI_OPEN, "worktree-lifecycle:prompts-get", "ssh-tools:prompts"];

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
				const messages = transcriptFor(tabId);
				return respond(command, { messages, totalMessages: messages.length });
			}
			case "get_transcript":
				return respond(command, { messages: transcriptFor(tabId) });
			case "get_available_models":
			case "get_providers":
				return respond(command, {
					models: MODELS,
					providers: PROVIDERS,
					discoveryStates: [],
					refreshPending: false,
					generation: 1,
				});
			case "history_recent":
				return respond(command, []);
			case "get_available_commands":
				return respond(command, { commands: [] });
			case "get_subagents":
				return respond(command, { subagents: [] });
			case "get_jobs":
				return respond(command, { jobs: [] });
			case "get_queue":
				return respond(command, { steering: [], followUp: [] });
			case "get_git_fingerprint":
				return respond(command, { fingerprint: "harness" });
			case "get_git_changes":
				return respond(command, GIT_CHANGES);
			default:
				note(`rpc:${command.type}`);
				return respond(command);
		}
	};

	const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
		calls.push({ channel, args });
		// Each case reads the one payload shape its channel carries.
		const payload: unknown = args[0];
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
			case IPC_COMMANDS.MODELS_SIGNED_IN:
				return true;
			case IPC_COMMANDS.MODELS_PROVIDERS_LIST:
				return { providers: [] };
			case IPC_COMMANDS.SETUP_GET_STATE:
			case IPC_COMMANDS.REMOTE_GET_STATE:
				return null;
			default:
				if (EMPTY_LISTS.includes(channel)) return [];
				note(channel);
				return undefined;
		}
	};

	const harness: Harness = {
		emit(channel, data) {
			for (const listener of listeners.get(channel) ?? []) listener(data);
		},
		unhandled,
		calls,
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
