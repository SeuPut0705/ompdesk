/**
 * The agent's risk table against what really exists: every IPC channel is classified for agents, every action is well
 * formed, and every Settings row is either an action or explicitly not written, with the reason. The tables live in the
 * Rust core (`agentctl/app/`); `app.catalog` hands them over, and these are the checks against the renderer's and the
 * shared lists, which the core cannot see.
 */
import { describe, expect, it } from "vitest";
import { AUTO_MODE_PREF } from "../../../resources/gui-bridge/modes/auto-mode-contracts";
import { AUTO_TITLE_EVOLVE_PREF, AUTO_TITLE_PREF } from "../../../resources/gui-bridge/modes/auto-title-contracts";
import { JUDGE_ASSIST_PREF } from "../../../resources/gui-bridge/modes/judge-assist-contracts";
import { NEXT_PROMPT_INLINE_PREF, NEXT_PROMPT_PREF } from "../../../resources/gui-bridge/modes/next-prompt-contracts";
import {
	CURATED_SCHEMA_ROWS,
	CUSTOM_SCHEMA_EDITORS,
	GUI_SEARCH_ITEMS,
	SETTINGS_SECTION_IDS,
} from "../../renderer/components/settings/settings-catalog";
import { PANEL_TABS, VIEW_SHEETS } from "../../renderer/stores/ui";
import { ACCOUNT_ROTATION_PREF } from "../../shared/account-rotation";
import { AGENT_PANEL_TABS, AGENT_VIEW_SHEETS, PRIVACY_PANES } from "../../shared/agent-control";
import { REA_PREF } from "../../shared/builtin-mcp";
import { DEFAULT_BROWSER_PREF } from "../../shared/default-browser";
import {
	APP_AUTO_UPDATE_PREF,
	AUTO_OPEN_CHANGES_PREF,
	AUTO_PREVIEW_DEV_SERVER_PREF,
	CLOSE_TO_TRAY_PREF,
	KEEP_AWAKE_WORKING_PREF,
	RESUME_INTERRUPTED_PREF,
	TOOLS_AUTO_UPDATE_PREF,
} from "../../shared/desktop-prefs";
import { LOCAL_ENGINE_DETECT_PREF } from "../../shared/local-engines";
import { REPLY_LANGUAGE_PREF } from "../../shared/reply-language";
import { THEME_NAMES } from "../../shared/theme-names";
import { APPROVAL_MODES } from "../../shared/tool-approval";
import { core } from "../core/process";
import { IPC_POLICY } from "../web/ipc-policy";

interface CatalogAction {
	id: string;
	description: string;
	args: { additionalProperties: boolean; properties: Record<string, { enum?: string[] }> };
	tier: string;
	neverReason?: string;
	manage?: { always: string } | { lifts: string };
	hasRun: boolean;
}

interface Catalog {
	actions: CatalogAction[];
	channels: Record<string, { never: string } | { tier: string; actions: string[] }>;
	settings: { id: string; kind: "pref" | "stock"; key?: string; path?: string; tier: string }[];
	rowNotWritten: Record<string, { covered: string } | { never: string }>;
	panelTabs: string[];
	viewSheets: string[];
	settingsSections: string[];
}

const catalog = (await core().call<Catalog>("app.catalog", {})).result;
const ACTION_BY_ID = new Map(catalog.actions.map(action => [action.id, action]));
const SETTING_BY_ID = new Map(catalog.settings.map(row => [row.id, row]));

describe("agent channel risk table", () => {
	it("classifies every IPC_POLICY channel: an action list or `never` with a reason", () => {
		expect(Object.keys(catalog.channels).sort()).toEqual(Object.keys(IPC_POLICY).sort());
		for (const [channel, risk] of Object.entries(catalog.channels)) {
			if ("never" in risk) expect(risk.never.length, channel).toBeGreaterThan(10);
			else {
				expect(risk.actions.length, channel).toBeGreaterThan(0);
				for (const id of risk.actions) expect(ACTION_BY_ID.get(id), `${channel} -> ${id}`).toBeDefined();
			}
		}
	});

	it("never offers the cards, a raw RPC passthrough or the pairing and credential channels", () => {
		for (const channel of ["extension-ui:respond", "rpc:command-for-tab", "rpc:command", "github-auth:logout"]) {
			const risk = catalog.channels[channel];
			expect(risk && "never" in risk, channel).toBe(true);
		}
	});
});

describe("action registry", () => {
	it("has unique ids, a schema, and a reason for every never action", () => {
		expect(ACTION_BY_ID.size).toBe(catalog.actions.length);
		for (const action of catalog.actions) {
			expect(action.description.length, action.id).toBeGreaterThan(10);
			expect(action.args.additionalProperties).toBe(false);
			if (action.tier === "never") {
				expect(action.neverReason?.length, action.id).toBeGreaterThan(10);
				expect(action.hasRun).toBe(false);
			} else expect(action.hasRun, action.id).toBe(true);
		}
	});

	it("makes every sensitive action decide, with a reason, whether agentControlManage lifts its card or it always asks", () => {
		for (const action of catalog.actions) {
			if (action.tier === "sensitive") {
				const rule = action.manage;
				expect(rule, `${action.id} needs a manage rule (lifts or always, with the reason)`).toBeDefined();
				const reason = rule && ("always" in rule ? rule.always : rule.lifts);
				expect(reason?.length ?? 0, action.id).toBeGreaterThan(20);
			} else expect(action.manage, `${action.id} is not sensitive: no manage rule`).toBeUndefined();
		}
	});

	it("keeps its copies of the renderer's lists equal", () => {
		expect(catalog.panelTabs).toEqual([...AGENT_PANEL_TABS]);
		expect(catalog.viewSheets).toEqual([...AGENT_VIEW_SHEETS]);
		expect(catalog.panelTabs).toEqual([...PANEL_TABS]);
		expect(catalog.viewSheets).toEqual([...VIEW_SHEETS]);
		expect(catalog.settingsSections).toEqual([...SETTINGS_SECTION_IDS]);
	});

	it("keeps its copies of the shared lists and preference keys equal", () => {
		expect(ACTION_BY_ID.get("ui.open_system_privacy")?.args.properties.pane?.enum).toEqual(
			Object.keys(PRIVACY_PANES),
		);
		expect(ACTION_BY_ID.get("agent_power.set")?.args.properties.mode?.enum).toEqual([...APPROVAL_MODES]);
		expect(ACTION_BY_ID.get("settings.theme")?.args.properties.value?.enum).toEqual(["system", ...THEME_NAMES]);
		expect(ACTION_BY_ID.get("ui.panel")?.args.properties.tab?.enum).toEqual([
			...AGENT_PANEL_TABS,
			...AGENT_VIEW_SHEETS,
			"close",
		]);
		const keys: Record<string, string> = {
			replyLanguage: REPLY_LANGUAGE_PREF,
			closeToTray: CLOSE_TO_TRAY_PREF,
			keepAwakeWorking: KEEP_AWAKE_WORKING_PREF,
			resumeInterrupted: RESUME_INTERRUPTED_PREF,
			autoPreviewDevServer: AUTO_PREVIEW_DEV_SERVER_PREF,
			autoOpenChanges: AUTO_OPEN_CHANGES_PREF,
			autoMode: AUTO_MODE_PREF,
			nextPromptSuggestions: NEXT_PROMPT_PREF,
			nextPromptInline: NEXT_PROMPT_INLINE_PREF,
			defaultBrowser: DEFAULT_BROWSER_PREF,
			autoTitle: AUTO_TITLE_PREF,
			autoTitleEvolve: AUTO_TITLE_EVOLVE_PREF,
			judgeAssist: JUDGE_ASSIST_PREF,
			appAutoUpdate: APP_AUTO_UPDATE_PREF,
			toolsAutoUpdate: TOOLS_AUTO_UPDATE_PREF,
			builtinRea: REA_PREF,
			rotation: ACCOUNT_ROTATION_PREF,
			localEngines: LOCAL_ENGINE_DETECT_PREF,
		};
		for (const [id, key] of Object.entries(keys)) expect(SETTING_BY_ID.get(id)?.key, id).toBe(key);
	});

	it("gives every Settings catalog row an action or a reason, and no row both", () => {
		const rows = [
			...GUI_SEARCH_ITEMS.map(item => item.id),
			...Object.keys(CURATED_SCHEMA_ROWS),
			...Object.keys(CUSTOM_SCHEMA_EDITORS),
		];
		const missing = rows.filter(id => !SETTING_BY_ID.has(id) && !catalog.rowNotWritten[id]);
		expect(missing).toEqual([]);
		expect(Object.keys(catalog.rowNotWritten).filter(id => SETTING_BY_ID.has(id))).toEqual([]);
		for (const decision of Object.values(catalog.rowNotWritten)) {
			if ("covered" in decision) expect(ACTION_BY_ID.get(decision.covered)).toBeDefined();
			else expect(decision.never.length).toBeGreaterThan(10);
		}
		for (const row of catalog.settings) expect(ACTION_BY_ID.get(`settings.${row.id}`)?.tier).toBe(row.tier);
	});

	it("offers no setting that gates the agent's own power", () => {
		for (const row of catalog.settings) {
			const key = row.kind === "pref" ? row.key : row.path;
			expect(key, row.id).not.toMatch(/agentControl|approval|approve|secrets|memory|computer|pstack|ecc|yolo/i);
		}
	});
});
