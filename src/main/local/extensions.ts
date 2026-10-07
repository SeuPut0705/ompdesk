/**
 * Extensions domain (skills, hooks, prompt templates, MCP, plugins,
 * marketplaces, plugin themes, memory report, agent definitions, subagent
 * lifecycle, TUI themes).
 *
 * Stock omp has none of these RPC commands. The `omp skill|plugin` CLIs cannot
 * stand in: `omp skill list --json` drops disabled skills, `omp plugin
 * marketplace list` / `discover` / `config` print text only, and stock's
 * headless `/mcp` edits config files without touching live connections. So
 * the gui-bridge extension answers them in-process against the live session
 * (resources/gui-bridge/extensions/*), with the same result shapes the fork
 * returned. `abort_subagent` maps onto stock `cancel_subagent`.
 */
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

/** Forward a command to the bridge method of the same name, params minus the frame envelope. */
const viaBridge: LocalHandler = ({ type, id: _id, ...params }, ctx) => ctx.bridge.request(type, params);

const BRIDGED = [
	"get_skills",
	"get_skill_detail",
	"set_skill_enabled",
	"manage_skill",
	"get_hooks",
	"set_hook_enabled",
	"get_prompt_templates",
	"get_mcp_servers",
	"mcp_action",
	"mcp_add",
	"mcp_test",
	"mcp_reauth_cancel",
	"get_plugins",
	"get_marketplaces",
	"marketplace_action",
	"set_plugin_enabled",
	"get_gui_themes",
	"get_plugin_detail",
	"set_plugin_features",
	"set_plugin_setting",
	"delete_plugin_setting",
	"get_memory_report",
	"get_agent_definitions",
	"get_agent_definition",
	"get_agent_authoring",
	"revive_subagent",
	"get_themes",
	"get_theme_colors",
] as const;

/** Stock `cancel_subagent` aborts a running subagent this session owns and tombstones it. */
async function abortSubagent(command: Parameters<LocalHandler>[0], ctx: LocalCommandContext) {
	if (typeof command.agentId !== "string" || !command.agentId)
		throw new Error("`agentId` must be a non-empty string.");
	const { cancelled } = await ctx.send<{ cancelled: boolean }>({
		type: "cancel_subagent",
		subagentId: command.agentId,
	});
	// Stock refuses anything it does not list as a live subagent of this session (main, advisors, unknown, parked).
	return cancelled ? { ok: true } : { ok: false, reason: "not_found" };
}

/** A second reauth while one is in flight fails with the fork's `oauth_busy` code. */
async function mcpReauth(command: Parameters<LocalHandler>[0], ctx: LocalCommandContext) {
	const result = await ctx.bridge.request<{ busy?: string }>("mcp_reauth", { name: command.name });
	if (typeof result.busy === "string") {
		throw new LocalCommandError(
			`MCP OAuth reauthorization already in progress for "${result.busy}". Complete or cancel it before starting another.`,
			"oauth_busy",
		);
	}
	return result;
}

export const handlers: Record<string, LocalHandler> = {
	...Object.fromEntries(BRIDGED.map(type => [type, viaBridge])),
	abort_subagent: abortSubagent,
	mcp_reauth: mcpReauth,
};
