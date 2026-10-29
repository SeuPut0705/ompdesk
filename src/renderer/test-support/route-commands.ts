/**
 * Unit-test doubles stub per-method RPCs (`getState`, `getSubagents`, …), but
 * the renderer sends every runtime command through `rpc.command` /
 * `rpc.commandForTab`, as the preload does. Route those to the stubbed methods
 * so a double stays a plain object of mocks and assertions keep reading them.
 */
import { vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";

interface CommandRouting {
	command: (command: RpcCommand, timeoutMs?: number) => Promise<RpcResponse>;
	commandForTab: (tabId: string, command: RpcCommand, timeoutMs?: number) => Promise<RpcResponse>;
}

/** The per-method double a command lands on, with its arguments; null when no double models it. */
function methodCall(command: RpcCommand): [method: string, args: unknown[]] | null {
	switch (command.type) {
		case "get_state":
			return ["getState", []];
		case "get_transcript":
			return ["getTranscript", []];
		case "get_transcript_page":
			return ["getTranscriptPage", [command.cursor, command.limit, command.fromEnd]];
		case "get_subagents":
			return ["getSubagents", []];
		case "get_subagent_messages":
			return ["getSubagentMessages", [command.subagentId, command.sessionFile, command.fromByte]];
		case "get_queue":
			return ["getQueue", []];
		case "get_goal":
			return ["getGoal", []];
		case "get_settings":
			return ["getSettings", [command.paths]];
		case "set_setting":
			return ["setSetting", [command.path, command.value]];
		case "get_available_models":
			return ["getAvailableModels", [command.forceRefresh]];
		case "get_providers":
			return ["getProviders", [command.forceRefresh]];
		case "set_fast_mode":
			return ["setFastMode", [command.enabled]];
		case "set_subagent_subscription":
			return ["setSubagentSubscription", [command.level]];
		case "switch_session":
			return [
				"switchSession",
				command.provider && command.modelId
					? [command.sessionPath, { provider: command.provider, modelId: command.modelId }]
					: [command.sessionPath],
			];
		default:
			return null;
	}
}

/** Add `command`/`commandForTab` (unless the double defines its own) that dispatch to `rpc`'s method doubles. */
export function routeCommands<T extends object>(rpc: T): T & CommandRouting {
	const routed = rpc as T & Partial<CommandRouting>;
	const command = (request: RpcCommand): Promise<RpcResponse> => {
		const call = methodCall(request);
		const method = call ? Reflect.get(routed, call[0]) : undefined;
		if (call && typeof method === "function") return Reflect.apply(method, routed, call[1]);
		return Promise.resolve({
			type: "response",
			command: request.type,
			success: false,
			error: `No test double for ${request.type}`,
		});
	};
	// Mocks like their siblings, so doubles that reset every method keep working.
	routed.command ??= vi.fn(command);
	routed.commandForTab ??= vi.fn((_tabId: string, request: RpcCommand, timeoutMs?: number) =>
		(routed.command ?? command)(request, timeoutMs),
	);
	return routed as T & CommandRouting;
}
