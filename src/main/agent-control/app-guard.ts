/**
 * The agent's own risk table for `ompdesk_app`, separate from `IPC_POLICY` (which says what a paired web device may
 * do, not what an agent may). Default DENY: a preference, stock setting, RPC command or IPC channel an action
 * touches must be listed here or in `app-settings.ts` / `app-channels.ts`, and each carries the tier it needs.
 * Every primitive an action can reach (`ActionContext` in `app-control.ts`) calls these checks, so a direct call and
 * a route through another command meet the same rules.
 *
 *   read       free
 *   change     free, journaled in the caller's session, shown as a toast, undoable when a previous value exists
 *   sensitive  one `[OMPdesk]` confirmation card unless the person turned `agentControlManage` on
 *   never      refused, whatever the switches: what gates the agent's own power, secrets, the cards
 */
import type { RpcCommand } from "../../shared/rpc-types";
import { SETTING_BY_ID, SETTINGS } from "./app-settings";

/** A refusal the agent reads: not a failure of the app. */
export class AppRefusal extends Error {}

export type Tier = "read" | "change" | "sensitive" | "never";
export type GrantedTier = Exclude<Tier, "never">;

const RANK: Record<GrantedTier, number> = { read: 0, change: 1, sensitive: 2 };

/** Whether an action granted `granted` may use something that needs `needed`. */
export function covers(granted: GrantedTier, needed: Tier): boolean {
	return needed !== "never" && RANK[needed] <= RANK[granted];
}

/**
 * Preferences that gate what an agent may do (its own tools, approvals, the memory and computer-use switches, the
 * sidebar blob that holds the sessions a person hid from agents) and credential-like keys. Refused even if a row
 * names them.
 */
export const POWER_PREF =
	/^(agentControl|approval|autoApprove|yolo|pstack|aiMemory|memory|computer|sidebar)|token|secret|password|passphrase|credential|api[-_]?key/i;

/** Stock settings with the same role: approvals, secrets handling, security, memory and computer use. */
export const POWER_SETTING =
	/^(tools\.approval|secrets\.|security\.|computer|memory\.|mnemopi|hindsight|autolearn|pstack|task\.agentAccountPools|providers\.)/i;

const PREF_TIER: Record<string, GrantedTier> = {};
for (const setting of SETTINGS) {
	if (setting.kind !== "pref") continue;
	PREF_TIER[setting.key] = setting.tier;
	for (const key of Object.keys(setting.mirror ?? {})) PREF_TIER[key] = setting.tier;
}

/** The tier a stored preference needs to be written; `never` for a power switch, a secret or a key no row lists. */
export function prefTier(key: string): Tier {
	if (POWER_PREF.test(key)) return "never";
	return PREF_TIER[key] ?? "never";
}

/** The tier a stock setting needs; `never` for approvals, secrets, memory and the like, and for paths no row lists. */
export function settingTier(path: string): Tier {
	if (POWER_SETTING.test(path)) return "never";
	const row = SETTING_BY_ID[path];
	return row?.kind === "stock" ? row.tier : "never";
}

/** True when some value inside holds another command (an object with a `type`): a route no action offers. */
function nestsCommand(value: unknown, depth = 0): boolean {
	if (depth > 0 && value !== null && typeof value === "object" && !Array.isArray(value) && "type" in value)
		return true;
	if (value === null || typeof value !== "object") return false;
	return Object.values(value).some(inner => nestsCommand(inner, depth + 1));
}

/** RPC commands an action may send; anything else is refused. A function decides by the command's own fields. */
const RPC_TIER: Record<string, Tier | ((command: RpcCommand) => Tier)> = {
	get_usage: "read",
	get_available_models: "read",
	get_settings: command => {
		if (command.type !== "get_settings" || !command.paths || command.paths.length === 0) return "never";
		return command.paths.every(path => !POWER_SETTING.test(path) && SETTING_BY_ID[path]?.kind === "stock")
			? "read"
			: "never";
	},
	set_setting: command => (command.type === "set_setting" ? settingTier(command.path) : "never"),
	set_model: "change",
	set_model_role: "change",
	set_thinking_level: "change",
	login: "sensitive",
	mcp_add: "sensitive",
	get_autopilot: "read",
	set_autopilot: command => {
		if (command.type !== "set_autopilot") return "never";
		if (command.action === "start") return "sensitive";
		return command.action === "stop" || command.action === "abort" ? "change" : "never";
	},
	marketplace_action: command =>
		command.type === "marketplace_action" && command.action === "install" ? "sensitive" : "never",
};

/** The tier an RPC command needs. A command another command carries, or one not listed, is `never`. */
export function rpcTier(command: RpcCommand): Tier {
	if (nestsCommand(command)) return "never";
	if (!Object.hasOwn(RPC_TIER, command.type)) return "never";
	const rule = RPC_TIER[command.type];
	return typeof rule === "function" ? rule(command) : (rule ?? "never");
}
