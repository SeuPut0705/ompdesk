/**
 * Vibe mode (port of the fork's RpcVibeModeController). Stock keeps every
 * mechanic on the session (`activateVibeTools`, `setVibeModeState`,
 * `runModeExitTeardown`) and the worker registry (`VibeSessionRegistry`); only
 * the TUI wires them to `/vibe`. This mirrors `InteractiveMode.#enterVibeMode`
 * / `#exitVibeMode` without the status-line widgets.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { VibeOwnerScope, VibeParentSession } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { assertToolSession, attach, record } from "./shared";

let previousTools: string[] | undefined;
let ownerScope: VibeOwnerScope | undefined;

async function parentSession(session: AgentSession): Promise<VibeParentSession> {
	const { formatModelStringWithRouting } = await import("@oh-my-pi/pi-coding-agent/config/model-resolver");
	return {
		getAgentId: () => session.getAgentId() ?? null,
		getSessionId: () => session.sessionManager.getSessionId(),
		getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
		sessionManager: session.sessionManager,
		asyncJobManager: session.asyncJobManager,
		settings: session.settings,
		getActiveModelString: () => (session.model ? formatModelStringWithRouting(session.model) : undefined),
	};
}

async function enter(session: AgentSession): Promise<{ enabled: boolean }> {
	if (session.getPlanModeState()?.enabled) throw new Error("Exit plan mode first.");
	const goal = session.getGoalModeState();
	if (goal?.enabled || goal?.goal?.status === "paused") throw new Error("Exit goal mode first.");
	assertToolSession(session, "Vibe mode");
	const { VibeSessionRegistry } = await import("@oh-my-pi/pi-coding-agent/vibe/runtime");
	const registry = VibeSessionRegistry.global();
	const scope = registry.ownerScope(await parentSession(session));
	registry.activateScope(scope);
	const before = session.getEnabledToolNames();
	const baseTools = session.hasBuiltInTool("todo") ? ["read", "todo"] : ["read"];
	await session.activateVibeTools(baseTools);
	previousTools = before;
	ownerScope = scope;
	session.setVibeModeState({ enabled: true });
	if (session.isStreaming) await session.sendVibeModeContext({ deliverAs: "steer" });
	session.sessionManager.appendModeChange("vibe", { previousTools: before });
	return { enabled: true };
}

async function exit(session: AgentSession): Promise<{ enabled: boolean; killedWorkers: number }> {
	const { VibeSessionRegistry } = await import("@oh-my-pi/pi-coding-agent/vibe/runtime");
	const parent = await parentSession(session);
	let killed = 0;
	// The queued-message drain stays suppressed so a queued prompt cannot restart on the vibe tools.
	await session.runModeExitTeardown(async () => {
		if (session.isStreaming) await session.abort();
		killed = await VibeSessionRegistry.global().killAll(parent, ownerScope);
		// A vibe state restored from the journal has no snapshot: drop just the vibe tools.
		if (previousTools) await session.deactivateVibeTools(previousTools);
		else await session.removeVibeToolsPreservingActive();
		session.setVibeModeState(undefined);
	});
	previousTools = undefined;
	ownerScope = undefined;
	return { enabled: false, killedWorkers: killed };
}

export const methods: BridgeMethods = guard("vibeMode", {
	"modes.get_vibe_mode": async (_params, env) => ({
		enabled: attach(env).getVibeModeState()?.enabled === true,
	}),
	"modes.set_vibe_mode": async (params, env) => {
		const session = attach(env);
		const enabled = record(params).enabled === true;
		if (enabled === (session.getVibeModeState()?.enabled === true)) return { enabled };
		return enabled ? enter(session) : exit(session);
	},
});
