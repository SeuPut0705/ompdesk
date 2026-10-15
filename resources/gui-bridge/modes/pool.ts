/**
 * Model pool (live half; the pure half is pool-core.ts): the user picks several
 * models, and while the pool is on the main agent decomposes each request and
 * spreads the subtasks across those models in parallel.
 *
 * Mechanism, chosen against omp 18.7 for stock compatibility:
 * - Routing uses the task tool's documented per-item `model` selector (top of
 *   stock's model precedence). Session agents (`m1`, `m2`, …) were rejected:
 *   stock registers them only from `^model` mentions in non-synthetic user text
 *   (ModelMentionRegistry is private), so the bridge cannot add them without
 *   rewriting the user's message. Generated agent definitions were rejected too:
 *   they would write files outside the session and leak into other sessions.
 * - The orchestration instruction is appended to the system prompt through the
 *   public `before_agent_start` extension hook, every prompt, from the pool the
 *   hooked session's own branch records. Subagent sessions have no pool entry,
 *   so they never receive it and do not re-distribute.
 * - The pool is a custom journal entry (`ompdesk.model-pool`; not LLM context),
 *   so it survives tab switches and restarts, follows branch navigation, and is
 *   restored on resume without any GUI-side bookkeeping.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import { normalizePool, type PoolState } from "../pool-contracts";
import { registerPromptSection } from "../prompt-sections";
import type { BridgeEnv, BridgeMethods } from "../types";
import { buildPoolInstruction, POOL_ENTRY_TYPE, poolFromEntries } from "./pool-core";

let latestEnv: BridgeEnv | undefined;

function readPool(session: AgentSession): PoolState {
	return poolFromEntries(session.sessionManager.getBranch());
}

function publish(state: PoolState): void {
	latestEnv?.emit({ type: "model_pool_update", state });
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	registerPromptSection(pi, "model-pool", ctx =>
		buildPoolInstruction(poolFromEntries(ctx.sessionManager.getBranch())),
	);
	// Branch navigation can cross a pool entry; tell the GUI what the new leaf records.
	const republish = () => {
		if (!latestEnv) return;
		try {
			publish(readPool(latestEnv.session()));
		} catch {
			// No live main session (mid-switch): the GUI re-reads on hydration.
		}
	};
	pi.on("session_switch", republish);
	pi.on("session_tree", republish);
	pi.on("session_branch", republish);
}

function setPool(session: AgentSession, params: unknown): PoolState {
	const next = normalizePool(params);
	if (next.enabled) {
		if (next.members.length < 2) throw new Error("A model pool needs at least two models.");
		if (!session.getEnabledToolNames().includes("task")) {
			throw new Error("The model pool needs the task tool, which is off in this session.");
		}
	}
	session.sessionManager.appendCustomEntry(POOL_ENTRY_TYPE, next);
	publish(next);
	return next;
}

export const methods: BridgeMethods = guard("modelPool", {
	"modes.get_model_pool": async (_params, env) => {
		latestEnv = env;
		return readPool(env.session());
	},
	/** `{enabled, members: [{selector, name, role}]}` → the stored pool (normalized). */
	"modes.set_model_pool": async (params, env) => {
		latestEnv = env;
		return setPool(env.session(), params);
	},
});
