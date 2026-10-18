/**
 * The `ompdesk_app` action registry: everything an agent may do to OMPdesk itself, one `AppAction` each (id, area,
 * description, argument schema, tier, how to run it). Which tier a call needs and whether it may touch a given
 * preference, stock setting, RPC command or IPC channel is decided centrally (`app-guard.ts`, `app-channels.ts`,
 * `app-control.ts`); an action here only says what it wants to do through `ActionContext`.
 *
 * The risk table `AGENT_CHANNELS` (app-channels.ts) names, per IPC channel, the actions that call it.
 */
import type { AgentAppEvent, AppUndo } from "../../shared/agent-control";
import { AGENT_PANEL_TABS } from "../../shared/agent-control";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { MOBILE_WEB_COMMAND, MOBILE_WEB_GET_STATE } from "../../shared/mobile-web";
import type { RpcCommand } from "../../shared/rpc-types";
import type { Tier } from "./app-guard";
import { type ArgsSchema, NO_ARGS, objectSchema } from "./app-schema";
import { type PrefSetting, SETTINGS, type Setting, settingActionId } from "./app-settings";

/** What an action returns: text for the agent, and, when it changed something, what to journal and toast. */
export interface ActionResult {
	text: string;
	change?: AppChange;
}

export interface AppChange {
	en: string;
	ko: string;
	/** The new value as shown to the person. */
	value: string;
	/** One step back, present only when there was a previous value to restore. */
	undo?: AppUndo;
}

/**
 * The only things an action can do. Each method runs the central checks first (the action's granted tier against
 * the tier the preference, setting, command or channel needs; `never` always refuses), so a route through another
 * command meets the same rule as a direct call.
 */
export interface ActionContext {
	readonly callerTabId: string;
	getPref(key: string): unknown;
	/** Write a stored preference through the same handler Settings uses, then tell the window to apply it. */
	setPref(key: string, value: unknown): Promise<void>;
	/** Send an RPC command to the calling session; resolves with the response data and throws on failure. */
	rpc(command: RpcCommand): Promise<unknown>;
	/** Call an invoke channel's handler (`channel` must list the running action in `AGENT_CHANNELS`). */
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	/** Call a fire-and-forget channel's handler. */
	fire(channel: string, ...args: unknown[]): void;
	ui(event: AgentAppEvent): void;
	/** Restore the last change this session's agent made (asks again when that change needed a card). */
	undoLast(): Promise<ActionResult>;
}

export interface AppAction {
	id: string;
	area: string;
	description: string;
	args: ArgsSchema;
	tier: Tier;
	/** Why a `never` action exists: shown to the agent so it does not try another route. */
	neverReason?: string;
	/** Absent for a `never` action. */
	run?: (ctx: ActionContext, args: Record<string, unknown>) => Promise<ActionResult>;
}

const SETTINGS_SECTIONS = [
	"general",
	"appearance",
	"keyboard",
	"models",
	"agent",
	"tools",
	"permissions",
	"workspace",
	"schedules",
	"connections",
	"updates",
	"advanced",
] as const;

export { SETTINGS_SECTIONS };

const C = IPC_COMMANDS;

const shown = (value: unknown): string =>
	typeof value === "string" ? value : typeof value === "boolean" ? (value ? "on" : "off") : JSON.stringify(value);

function stockValue(data: unknown, path: string): unknown {
	if (data && typeof data === "object" && "values" in data && data.values && typeof data.values === "object")
		return (data.values as Record<string, unknown>)[path];
	return undefined;
}

async function readStock(ctx: ActionContext, path: string): Promise<unknown> {
	return stockValue(await ctx.rpc({ type: "get_settings", paths: [path] }), path);
}

async function writeSetting(ctx: ActionContext, row: Setting, value: unknown): Promise<ActionResult> {
	const label = `${row.en}`;
	if (row.kind === "stock") {
		const previous = await readStock(ctx, row.path);
		await ctx.rpc({ type: "set_setting", path: row.path, value });
		return {
			text: `${row.en} is now ${shown(value)}.`,
			change: {
				en: label,
				ko: row.ko,
				value: shown(value),
				...(previous === undefined || previous === null
					? {}
					: { undo: { kind: "setting", path: row.path, value: previous } }),
			},
		};
	}
	const previous = row.redact ? undefined : ctx.getPref(row.key);
	const stored = value === "" ? null : value;
	await ctx.setPref(row.key, stored);
	for (const [key, derive] of Object.entries(row.mirror ?? {})) await ctx.setPref(key, derive(value));
	return {
		text: `${row.en} is now ${row.redact ? "set" : shown(value)}.`,
		change: {
			en: label,
			ko: row.ko,
			value: row.redact ? "…" : shown(value),
			...(previous === undefined || previous === null
				? {}
				: { undo: { kind: "pref", key: row.key, value: previous } }),
		},
	};
}

function settingAction(row: Setting): AppAction {
	const hint =
		row.schema.type === "string" && row.schema.enum
			? ` One of: ${row.schema.enum.join(", ")}.`
			: row.schema.type === "boolean"
				? " true or false."
				: "";
	return {
		id: settingActionId(row.id),
		area: `settings/${row.area}`,
		description: `Set "${row.en}".${hint}`,
		args: objectSchema({ value: row.schema }, ["value"]),
		tier: row.tier,
		run: (ctx, args) => writeSetting(ctx, row, args.value),
	};
}

function describeUsage(data: unknown): string {
	const reports =
		data && typeof data === "object" && "reports" in data && Array.isArray(data.reports) ? data.reports : [];
	if (reports.length === 0) return "No provider usage reports yet (no signed-in account reports a quota).";
	return reports
		.map((report: { provider?: string; account?: string; limits?: Array<Record<string, unknown>> }) => {
			const limits = (report.limits ?? []).map(limit => {
				const used =
					typeof limit.usedFraction === "number" ? `${Math.round(limit.usedFraction * 100)}% used` : "n/a";
				return `${String(limit.windowLabel ?? limit.label ?? limit.id)} ${used}`;
			});
			return `- ${report.provider ?? "?"}${report.account ? ` (${report.account})` : ""}: ${limits.join("; ") || "no windows"}`;
		})
		.join("\n");
}

function lines(values: readonly unknown[], pick: (value: Record<string, unknown>) => string, empty: string): string {
	const rows = values.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object");
	return rows.length === 0 ? empty : rows.map(pick).join("\n");
}

const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

const never = (id: string, area: string, description: string, neverReason: string): AppAction => ({
	id,
	area,
	description,
	args: NO_ARGS,
	tier: "never",
	neverReason,
});

const SESSION_PATH = {
	type: "string",
	minLength: 1,
	maxLength: 4096,
	description: "Session file path (.jsonl) from sessions.saved.",
} as const;
const SCOPE = {
	type: "string",
	enum: ["local", "global"],
	description: "local: this folder's sessions; global (default): all.",
} as const;

const SIGN_IN_NOTE =
	"Only starts the existing sign-in flow (a browser page or a code the person completes); it never reads or stores a credential.";

export const APP_ACTIONS: readonly AppAction[] = [
	{
		id: "settings.get",
		area: "settings",
		description:
			'Read the current value of settings rows (ids as ompdesk_app_list shows after "settings."); all rows when ids is omitted. Secrets are never shown.',
		args: objectSchema({ ids: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 80 } }),
		tier: "read",
		run: async (ctx, args) => {
			const wanted = Array.isArray(args.ids) ? new Set(args.ids as string[]) : null;
			const rows = SETTINGS.filter(row => !wanted || wanted.has(row.id));
			const stockRows = rows.filter(row => row.kind === "stock");
			const stockData =
				stockRows.length > 0
					? await ctx.rpc({ type: "get_settings", paths: stockRows.map(row => row.id) }).catch(() => undefined)
					: undefined;
			const out = rows.map(row => {
				const value =
					row.kind === "stock" ? stockValue(stockData, row.path) : ctx.getPref((row as PrefSetting).key);
				const redact = row.kind === "pref" && row.redact === true;
				const display = redact ? (value ? "(set)" : "(unset)") : value === undefined ? "(default)" : shown(value);
				return `- ${row.id}: ${display}${row.tier === "sensitive" ? " [asks the user]" : ""}`;
			});
			return { text: out.length > 0 ? out.join("\n") : "No settings row matches." };
		},
	},
	{
		id: "usage.read",
		area: "usage",
		description:
			"Provider usage and quota windows of the signed-in accounts (what the Usage view shows). refresh asks the providers now.",
		args: objectSchema({ refresh: { type: "boolean" } }),
		tier: "read",
		run: async (ctx, args) => ({
			text: describeUsage(await ctx.rpc({ type: "get_usage", refresh: args.refresh === true })),
		}),
	},
	{
		id: "models.list",
		area: "models",
		description: "Models this session can use (provider and id).",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => {
			const data = await ctx.rpc({ type: "get_available_models" });
			const models =
				data && typeof data === "object" && "models" in data && Array.isArray(data.models) ? data.models : [];
			return { text: lines(models, model => `- ${text(model.provider)}/${text(model.id)}`, "No models available.") };
		},
	},
	{
		id: "models.set",
		area: "models",
		description: "Switch this session's model.",
		args: objectSchema(
			{
				provider: { type: "string", minLength: 1, maxLength: 100 },
				modelId: { type: "string", minLength: 1, maxLength: 200 },
			},
			["provider", "modelId"],
		),
		tier: "change",
		run: async (ctx, args) => {
			await ctx.rpc({ type: "set_model", provider: String(args.provider), modelId: String(args.modelId) });
			const value = `${String(args.provider)}/${String(args.modelId)}`;
			return { text: `This session now uses ${value}.`, change: { en: "Model", ko: "모델", value } };
		},
	},
	{
		id: "models.set_role",
		area: "models",
		description:
			"Assign a model to a model role (default, slow, smol, plan, task, ...); omit modelId to clear the role.",
		args: objectSchema(
			{
				role: { type: "string", minLength: 1, maxLength: 60 },
				modelId: { type: "string", minLength: 1, maxLength: 200 },
			},
			["role"],
		),
		tier: "change",
		run: async (ctx, args) => {
			const modelId = typeof args.modelId === "string" ? args.modelId : null;
			await ctx.rpc({ type: "set_model_role", role: String(args.role), modelId });
			return {
				text: modelId ? `Role ${String(args.role)} now uses ${modelId}.` : `Role ${String(args.role)} cleared.`,
				change: {
					en: `Model role ${String(args.role)}`,
					ko: `모델 역할 ${String(args.role)}`,
					value: modelId ?? "(cleared)",
				},
			};
		},
	},
	{
		id: "ui.panel",
		area: "ui",
		description: "Open a view in the side panel (preview, diff, files, terminal, ...) or close the panel.",
		args: objectSchema({ tab: { type: "string", enum: [...AGENT_PANEL_TABS, "close"] } }, ["tab"]),
		tier: "change",
		run: async (ctx, args) => {
			const tab = args.tab as (typeof AGENT_PANEL_TABS)[number] | "close";
			ctx.ui({ kind: "panel", tab: tab === "close" ? null : tab });
			return { text: tab === "close" ? "Side panel closed." : `Side panel shows ${tab}.` };
		},
	},
	{
		id: "ui.settings_open",
		area: "ui",
		description: "Open Settings at a section (for the user to look at or to finish a step only they may do).",
		args: objectSchema(
			{ section: { type: "string", enum: [...SETTINGS_SECTIONS] }, sub: { type: "string", maxLength: 60 } },
			["section"],
		),
		tier: "change",
		run: async (ctx, args) => {
			ctx.ui({
				kind: "settings",
				section: String(args.section),
				...(typeof args.sub === "string" ? { sub: args.sub } : {}),
			});
			return { text: `Settings opened at ${String(args.section)}.` };
		},
	},
	{
		id: "sessions.saved",
		area: "sessions",
		description: "Saved sessions on this computer (title, folder, last change, path).",
		args: objectSchema({ scope: SCOPE }),
		tier: "read",
		run: async (ctx, args) => {
			const sessions = await ctx.invoke(C.SESSIONS_LIST, { scope: args.scope === "local" ? "local" : "global" });
			const rows = Array.isArray(sessions) ? sessions.slice(0, 50) : [];
			return {
				text: lines(
					rows,
					row =>
						`- ${text(row.title, "(untitled)")} · ${text(row.cwd)} · ${text(row.modified)} · ${text(row.path)}`,
					"No saved sessions.",
				),
			};
		},
	},
	{
		id: "sessions.search",
		area: "sessions",
		description: "Search the text of saved sessions.",
		args: objectSchema({ query: { type: "string", minLength: 1, maxLength: 200 }, scope: SCOPE }, ["query"]),
		tier: "read",
		run: async (ctx, args) => {
			const hits = await ctx.invoke(C.SESSIONS_SEARCH, {
				query: String(args.query),
				scope: args.scope === "local" ? "local" : "global",
			});
			const rows = Array.isArray(hits) ? hits.slice(0, 30) : [];
			return { text: lines(rows, row => `- ${text(row.path)}: ${text(row.snippet)}`, "No matches.") };
		},
	},
	{
		id: "sessions.rename",
		area: "sessions",
		description: "Rename a saved session.",
		args: objectSchema({ sessionPath: SESSION_PATH, name: { type: "string", minLength: 1, maxLength: 200 } }, [
			"sessionPath",
			"name",
		]),
		tier: "change",
		run: async (ctx, args) => {
			await ctx.invoke(C.SESSIONS_RENAME, { sessionPath: String(args.sessionPath), name: String(args.name) });
			return { text: "Renamed.", change: { en: "Session name", ko: "세션 이름", value: String(args.name) } };
		},
	},
	{
		id: "sessions.delete",
		area: "sessions",
		description: "Delete a saved session file for good.",
		args: objectSchema({ sessionPath: SESSION_PATH }, ["sessionPath"]),
		tier: "sensitive",
		run: async (ctx, args) => {
			await ctx.invoke(C.SESSIONS_DELETE, { sessionPath: String(args.sessionPath) });
			return {
				text: "Deleted.",
				change: { en: "Deleted a saved session", ko: "저장된 세션 삭제", value: String(args.sessionPath) },
			};
		},
	},
	{
		id: "updates.status",
		area: "updates",
		description: "The state of OMPdesk's own update (idle, available, downloaded, ...).",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => {
			const status = await ctx.invoke(C.UPDATER_GET_STATUS);
			const state = status && typeof status === "object" && "state" in status ? String(status.state) : "unknown";
			const version =
				status && typeof status === "object" && "version" in status ? ` ${String(status.version)}` : "";
			return { text: `Update state: ${state}${version}.` };
		},
	},
	{
		id: "updates.check",
		area: "updates",
		description: "Check for a new OMPdesk version now (contacts the release server).",
		args: NO_ARGS,
		tier: "sensitive",
		run: async ctx => {
			await ctx.invoke(C.UPDATER_CHECK);
			return { text: "Update check started; read updates.status for the result." };
		},
	},
	{
		id: "updates.apply",
		area: "updates",
		description: "Install the downloaded OMPdesk update and restart the app (every running turn ends).",
		args: NO_ARGS,
		tier: "sensitive",
		run: async ctx => {
			await ctx.invoke(C.UPDATER_APPLY);
			return { text: "Applying the update; OMPdesk restarts." };
		},
	},
	{
		id: "app.quit",
		area: "app",
		description: "Quit OMPdesk (every running turn ends).",
		args: NO_ARGS,
		tier: "sensitive",
		run: async ctx => {
			ctx.fire(C.APP_QUIT);
			return { text: "Quitting OMPdesk." };
		},
	},
	{
		id: "accounts.github_status",
		area: "accounts",
		description: "Whether GitHub CLI is signed in and as which login.",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => {
			const state = await ctx.invoke(C.GITHUB_AUTH_REFRESH, false);
			const status = state && typeof state === "object" && "status" in state ? state.status : null;
			if (!status || typeof status !== "object") return { text: "GitHub status is not known yet." };
			const record = status as Record<string, unknown>;
			return {
				text: record.authenticated
					? `Signed in to GitHub as ${text(record.login, "?")}.`
					: "Not signed in to GitHub.",
			};
		},
	},
	{
		id: "accounts.github_sign_in",
		area: "accounts",
		description: `Start GitHub sign-in. ${SIGN_IN_NOTE}`,
		args: NO_ARGS,
		tier: "sensitive",
		run: async ctx => {
			await ctx.invoke(C.GITHUB_AUTH_LOGIN_START);
			return { text: "GitHub sign-in started: the person finishes it in the window." };
		},
	},
	{
		id: "accounts.provider_sign_in",
		area: "accounts",
		description: `Start sign-in for a model provider. ${SIGN_IN_NOTE}`,
		args: objectSchema({ providerId: { type: "string", minLength: 1, maxLength: 100 } }, ["providerId"]),
		tier: "sensitive",
		run: async (ctx, args) => {
			await ctx.rpc({ type: "login", providerId: String(args.providerId) });
			return { text: `Sign-in for ${String(args.providerId)} started: the person finishes it in the window.` };
		},
	},
	{
		id: "mobile_web.status",
		area: "mobile_web",
		description: "Whether the phone page is on and its state (the link is not shown).",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => {
			const state = await ctx.invoke(MOBILE_WEB_GET_STATE);
			const record = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
			return { text: `Mobile web: ${record.enabled ? "on" : "off"}, phase ${text(record.phase, "unknown")}.` };
		},
	},
	{
		id: "mobile_web.set_enabled",
		area: "mobile_web",
		description: "Turn the phone page on or off (it exposes this computer's sessions to the person's tailnet).",
		args: objectSchema({ enabled: { type: "boolean" } }, ["enabled"]),
		tier: "sensitive",
		run: async (ctx, args) => {
			await ctx.invoke(MOBILE_WEB_COMMAND, { action: args.enabled === true ? "enable" : "disable" });
			return {
				text: `Mobile web ${args.enabled === true ? "enabled" : "disabled"}.`,
				change: { en: "Mobile web", ko: "모바일 웹", value: shown(args.enabled === true) },
			};
		},
	},
	{
		id: "extensions.install_plugin",
		area: "extensions",
		description: "Install a plugin from a marketplace the person already added (it runs code in every session).",
		args: objectSchema(
			{
				marketplace: { type: "string", minLength: 1, maxLength: 200 },
				plugin: { type: "string", minLength: 1, maxLength: 200 },
			},
			["marketplace", "plugin"],
		),
		tier: "sensitive",
		run: async (ctx, args) => {
			await ctx.rpc({
				type: "marketplace_action",
				action: "install",
				marketplace: String(args.marketplace),
				plugin: String(args.plugin),
			});
			return {
				text: `Installed ${String(args.plugin)}.`,
				change: { en: "Installed plugin", ko: "플러그인 설치", value: String(args.plugin) },
			};
		},
	},
	{
		id: "memory.purge",
		area: "memory",
		description: "Erase the user's ai-memory for good.",
		args: NO_ARGS,
		tier: "sensitive",
		run: async ctx => {
			await ctx.rpc({ type: "memory_clear" });
			return { text: "Memory erased.", change: { en: "Memory", ko: "메모리", value: "erased" } };
		},
	},
	{
		id: "app.undo",
		area: "app",
		description: "Undo the last change you made with ompdesk_app, when it had a previous value.",
		args: NO_ARGS,
		tier: "change",
		run: ctx => ctx.undoLast(),
	},
	never(
		"agent_power.set",
		"permissions",
		"Change what agents may do: control tools, approval mode, who may approve, memory or computer-use switches.",
		"These switches bound the agent's own power. Only the person changes them, in Settings.",
	),
	never(
		"cards.answer",
		"permissions",
		"Answer an [OMPdesk] confirmation card or a tool approval.",
		"A card exists to ask the person. ompdesk_session_answer refuses it too.",
	),
	never(
		"credentials.read",
		"accounts",
		"Read an API key, token, password, proxy credential or the sign-in state of an account.",
		"Secrets never reach an agent. Use accounts.*_status for who is signed in.",
	),
	never(
		"extensions.install_mcp",
		"extensions",
		"Add an MCP server (it starts a program or reaches a network service).",
		"Not offered: the person adds MCP servers in Settings › Tools & extensions.",
	),
	never(
		"remote.pair",
		"connections",
		"Pair another computer or a phone with this one.",
		"Pairing trusts a device with this computer's sessions. The person does it in Settings › Devices & connections.",
	),
	...SETTINGS.map(settingAction),
];

export const ACTION_BY_ID: Readonly<Record<string, AppAction>> = Object.fromEntries(
	APP_ACTIONS.map(action => [action.id, action]),
);
