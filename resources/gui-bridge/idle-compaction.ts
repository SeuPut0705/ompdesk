/**
 * Idle compaction for GUI tabs. Stock omp has the settings
 * (`compaction.idleEnabled`, `compaction.idleThresholdTokens`,
 * `compaction.idleTimeoutSeconds`) and the work (`AgentSession.runIdleCompaction()`),
 * but the timer that calls it lives only in the TUI's event controller, so in
 * RPC mode the settings did nothing. This module runs the same timer
 * (rules in idle-compaction-core.ts) on the live session's events.
 *
 * The TUI reads its editor; the bridge cannot see the GUI draft, so the
 * renderer reports when a tab's draft turns empty or non-empty
 * (`idle_compaction_draft`, src/renderer/hooks/use-idle-compaction-draft.ts).
 * That call also attaches the subscription, once per live session.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "./health";
import { IdleCompactionTimer } from "./idle-compaction-core";
import type { BridgeMethods } from "./types";

const timer = new IdleCompactionTimer<AgentSession>(async session => {
	// Deferred like compaction-limits.ts: stock internals load only after `guard` checked the feature.
	const [{ cfgCompaction }, { getCacheWarmingDelayMs }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/session/context-settings"),
		import("@oh-my-pi/pi-coding-agent/session/cache-warmer"),
	]);
	return { ...cfgCompaction.get(session.settings), cacheWarmingDelayMs: getCacheWarmingDelayMs };
});
const subscribed = new WeakSet<AgentSession>();
let attached: AgentSession | undefined;

/** Called by settings.ts after a write: re-arm while idle when an idle setting changed (stock does the same). */
export function idleSettingChanged(path: string): void {
	if (attached) void timer.settingChanged(path, attached)?.catch(() => {});
}

export const methods: BridgeMethods = guard("idleCompaction", {
	/** `{empty}`: the tab's composer draft is (not) empty. Attaches the timer to the live session. */
	idle_compaction_draft: async (params, env) => {
		const empty = typeof params === "object" && params !== null && "empty" in params ? params.empty : undefined;
		if (typeof empty !== "boolean") throw new Error("idle_compaction_draft needs {empty: boolean}");
		const session = env.session();
		attached = session;
		if (!subscribed.has(session)) {
			subscribed.add(session);
			session.subscribe(event => void timer.onEvent(event, session)?.catch(() => {}));
		}
		await timer.setDraftEmpty(empty, session);
		return { armed: timer.armed };
	},
});
