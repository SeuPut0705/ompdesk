/**
 * After an extension update, which live tabs pick it up and when (the pattern of omp-restart.ts). A running
 * turn is never touched: a tab in a turn applies the update one tick after the turn ends. Every other ready
 * tab applies it at once: a plugin that ships extensions, tools or hooks needs a restart (they bind at session
 * creation), so the tab restarts on its session file; everything else is the `/reload-plugins` reload and, for
 * an MCP server whose package changed, stock's reconnect of that server. A tab that never started (`asleep`)
 * needs nothing: its first spawn loads the current files. A tab still starting or in `error` is left alone
 * (it loads the current files, or restarts anyway).
 */
import type { McpLiveChange } from "../../resources/gui-bridge/extensions/mcp-contracts";
import type { SidecarStatus } from "../shared/rpc-types";

export interface ExtensionApplyPlan {
	/** Skills, commands or plugin files changed: run the `/reload-plugins` reload. */
	reload: boolean;
	/** A plugin that binds at session creation changed: restart the tab (implies the reload). */
	restart: boolean;
	/** MCP servers whose package or binary changed: reconnect them. */
	reconnect: string[];
	/**
	 * MCP configuration or credentials another session changed (mcp-live.ts): the bridge's `mcp_sync` brings the
	 * tab's connections to what disk says, touching only what moved.
	 */
	mcp?: McpLiveChange;
}

export const EMPTY_APPLY_PLAN: ExtensionApplyPlan = { reload: false, restart: false, reconnect: [] };

export function planIsEmpty(plan: ExtensionApplyPlan): boolean {
	return !plan.reload && !plan.restart && plan.reconnect.length === 0 && !plan.mcp;
}

export function mergeApplyPlans(a: ExtensionApplyPlan, b: ExtensionApplyPlan): ExtensionApplyPlan {
	return {
		reload: a.reload || b.reload,
		restart: a.restart || b.restart,
		reconnect: [...new Set([...a.reconnect, ...b.reconnect])],
		...(a.mcp || b.mcp ? { mcp: mergeMcp(a.mcp, b.mcp) } : {}),
	};
}

function mergeMcp(a: McpLiveChange | undefined, b: McpLiveChange | undefined): McpLiveChange {
	if (a?.all || b?.all) return { names: [], all: true };
	return { names: [...new Set([...(a?.names ?? []), ...(b?.names ?? [])])] };
}

export type ExtensionApplyDecision = "now" | "wait" | "skip";

export function extensionApplyDecision(facts: { status: SidecarStatus; busy: boolean }): ExtensionApplyDecision {
	if (facts.status === "asleep") return "skip";
	if (facts.busy) return facts.status === "starting" || facts.status === "error" ? "skip" : "wait";
	return facts.status === "ready" ? "now" : "skip";
}
