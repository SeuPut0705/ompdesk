import type { RpcCommand, RpcResponse, RpcResponseError } from "../../shared/rpc-types";
import { createAutopilotStore } from "./autopilot";
import { type ComposerStore, createComposerStore } from "./composer";
import { createExtensionUiStore } from "./extension-ui";
import { createMessagesStore } from "./messages";
import { createModelStore } from "./model";
import { createPlanApprovalStore } from "./plan-approval";
import { createQueueStore } from "./queue";
import { createSessionStore, type SessionStore } from "./session";
import {
	addRuntimeStore,
	deleteSessionRuntime,
	registerSessionRuntime,
	type SessionRuntime,
	sessionRuntime,
	sessionRuntimeStore,
} from "./session-runtime-context";
import { createSettingsStore } from "./settings";
import { createSubagentGraphStore } from "./subagent-graph";
import { createSubagentsStore, type SubagentsStore } from "./subagents";
import { createTodoStore } from "./todo";
import { createToolsStore } from "./tools";

const SESSION_CHANGING_COMMANDS = new Set<RpcCommand["type"]>([
	"new_session",
	"switch_session",
	"branch",
	"fork",
	"handoff",
	"fresh",
	"tan",
	"switch_leaf",
	"clear_context",
]);

function replacedSessionResponse(command: RpcCommand): RpcResponseError {
	return {
		type: "response",
		command: command.type,
		success: false,
		error: "The originating session was replaced or closed. Refresh this view before retrying.",
	};
}

export function createTabRuntime(tabId: string): SessionRuntime {
	let generation = 0;
	const command = async (rpcCommand: RpcCommand, timeoutMs?: number): Promise<RpcResponse> => {
		// An old dialog/continuation must not send a mutation to this tab's new owner.
		if (sessionRuntime(tabId) !== runtime) return replacedSessionResponse(rpcCommand);
		// Hydration reasserts progress; keep events while an inline surface owns a lease.
		if (
			rpcCommand.type === "set_subagent_subscription" &&
			rpcCommand.level === "progress" &&
			(sessionRuntimeStore<SubagentsStore>(tabId, "subagents")?.getState().eventConsumers ?? 0) > 0
		) {
			rpcCommand = { ...rpcCommand, level: "events" };
		}
		const changesSession = SESSION_CHANGING_COMMANDS.has(rpcCommand.type);
		if (changesSession) generation++;
		const requestGeneration = generation;
		const origin = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId;
		const response = await window.omp.rpc.commandForTab(tabId, rpcCommand, timeoutMs);
		// Session metadata can retire this runtime before its own lifecycle ACK.
		// Preserve the execution outcome; callers guard any subsequent UI writes.
		if (changesSession) return response;
		if (
			requestGeneration !== generation ||
			sessionRuntime(tabId) !== runtime ||
			(origin && sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId !== origin)
		) {
			return {
				...replacedSessionResponse(rpcCommand),
				code: response.success ? "rpc_delivery_unknown" : response.code,
			};
		}
		return response;
	};

	const runtime: SessionRuntime = { tabId, command, stores: new Map() };
	addRuntimeStore(runtime, "autopilot", createAutopilotStore());
	addRuntimeStore(runtime, "composer", createComposerStore());
	addRuntimeStore(runtime, "extensionUi", createExtensionUiStore());
	addRuntimeStore(runtime, "messages", createMessagesStore());
	addRuntimeStore(runtime, "model", createModelStore(command));
	addRuntimeStore(runtime, "planApproval", createPlanApprovalStore());
	addRuntimeStore(runtime, "queue", createQueueStore(command));
	addRuntimeStore(runtime, "session", createSessionStore());
	addRuntimeStore(runtime, "settings", createSettingsStore(command));
	addRuntimeStore(runtime, "subagentGraph", createSubagentGraphStore());
	addRuntimeStore(runtime, "subagents", createSubagentsStore(command));
	addRuntimeStore(runtime, "todo", createTodoStore());
	addRuntimeStore(runtime, "tools", createToolsStore());
	return registerSessionRuntime(runtime);
}

export function ensureTabRuntime(tabId: string): SessionRuntime {
	return sessionRuntime(tabId) ?? createTabRuntime(tabId);
}

/** Replace stale session state, retaining unsent input only across a process restart. */
export function replaceTabRuntime(tabId: string): SessionRuntime {
	const recovering = sessionRuntime(tabId)?.recovering;
	const composer = recovering ? sessionRuntimeStore<ComposerStore>(tabId, "composer") : null;
	deleteSessionRuntime(tabId);
	const runtime = createTabRuntime(tabId);
	runtime.recovering = recovering;
	if (composer) {
		// The pending send still owns this draft. Its ACK/failure must settle into
		// the recovered task even when an unsaved Core session gets a fresh id.
		addRuntimeStore(runtime, "composer", composer);
	}
	return runtime;
}
