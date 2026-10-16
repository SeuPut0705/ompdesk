/**
 * Ratchet (stock `/ratchet`: build or reuse an eval for an LLM flow, then hillclimb it unattended). Stock arms it
 * in `prepareRatchet` (slash-commands/builtin-modes.ts): `ratchet.enabled` is overridden for the session (never
 * persisted), which adds the `ratchet()` prelude to the eval kernel, and it needs the `eval` and `task` tools.
 * Over RPC `/ratchet <request>` as a prompt works, but the Mode popover wants a switch with the state read back
 * from stock, so this applies the same override on the live session. The kickoff itself stays stock's: the user
 * then describes the flow in a message or sends `/ratchet <flow>`.
 * Ratchet is manual only: nothing in OMPdesk turns it on by itself.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { attach, record } from "./shared";

/** Tools the ratchet loop needs: the eval kernel hosts `ratchet()`, `task` runs its analyzer (stock's list). */
const REQUIRED_TOOLS = ["eval", "task"] as const;

export interface RatchetState {
	enabled: boolean;
	/** Required tools that are not active in this session; non-empty means Ratchet cannot be turned on. */
	missing: string[];
}

async function setting() {
	const { cfgRatchetEnabled } = await import("@oh-my-pi/pi-coding-agent/tools/settings");
	return cfgRatchetEnabled;
}

async function state(session: AgentSession): Promise<RatchetState> {
	const tools = session.getEnabledToolNames();
	return {
		enabled: (await setting()).get(session.settings) === true,
		missing: REQUIRED_TOOLS.filter(tool => !tools.includes(tool)),
	};
}

/** Whether Ratchet is on for the session (the automatic mode choice treats it as a mode the user picked). */
export async function ratchetEnabled(session: AgentSession): Promise<boolean> {
	return (await setting()).get(session.settings) === true;
}

export const methods: BridgeMethods = guard("ratchet", {
	"modes.get_ratchet": async (_params, env) => state(attach(env)),
	"modes.set_ratchet": async (params, env) => {
		const session = attach(env);
		const cfg = await setting();
		const enabled = record(params).enabled === true;
		if (!enabled) {
			cfg.override(session.settings, false);
			return state(session);
		}
		const current = await state(session);
		if (current.missing.length > 0)
			throw new Error(`Ratchet needs the ${current.missing.join(" and ")} tool active.`);
		const previous = cfg.get(session.settings);
		if (!previous) cfg.override(session.settings, true);
		if (!session.getEvalPreludes().some(definition => definition.name === "ratchet")) {
			if (!previous) cfg.override(session.settings, previous);
			throw new Error("The ratchet eval prelude is unavailable in this session.");
		}
		return state(session);
	},
});
