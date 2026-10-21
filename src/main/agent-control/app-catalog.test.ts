/**
 * The agent's risk table against what really exists: every IPC channel is classified for agents (the type already
 * forces an entry; this checks the entry's content), every action is well formed, and every Settings row is either
 * an action or explicitly not written, with the reason.
 */
import { describe, expect, it } from "vitest";
import {
	CURATED_SCHEMA_ROWS,
	CUSTOM_SCHEMA_EDITORS,
	GUI_SEARCH_ITEMS,
	SETTINGS_SECTION_IDS,
} from "../../renderer/components/settings/settings-catalog";
import { PANEL_TABS, VIEW_SHEETS } from "../../renderer/stores/ui";
import { AGENT_PANEL_TABS, AGENT_VIEW_SHEETS } from "../../shared/agent-control";
import { IPC_POLICY } from "../web/ipc-policy";
import { ACTION_BY_ID, APP_ACTIONS, SETTINGS_SECTIONS } from "./app-catalog";
import { AGENT_CHANNELS } from "./app-channels";
import { ROW_NOT_WRITTEN, SETTING_BY_ID, SETTINGS, settingActionId } from "./app-settings";

describe("agent channel risk table", () => {
	it("classifies every IPC_POLICY channel: an action list or `never` with a reason", () => {
		expect(Object.keys(AGENT_CHANNELS).sort()).toEqual(Object.keys(IPC_POLICY).sort());
		for (const [channel, risk] of Object.entries(AGENT_CHANNELS)) {
			if ("never" in risk) expect(risk.never.length, channel).toBeGreaterThan(10);
			else {
				expect(risk.actions.length, channel).toBeGreaterThan(0);
				for (const id of risk.actions) expect(ACTION_BY_ID[id], `${channel} -> ${id}`).toBeDefined();
			}
		}
	});

	it("never offers the cards, a raw RPC passthrough or the pairing and credential channels", () => {
		for (const channel of ["extension-ui:respond", "rpc:command-for-tab", "rpc:command", "github-auth:logout"]) {
			const risk = AGENT_CHANNELS[channel as keyof typeof AGENT_CHANNELS];
			expect(risk && "never" in risk, channel).toBe(true);
		}
	});
});

describe("action registry", () => {
	it("has unique ids, a schema, and a reason for every never action", () => {
		expect(new Set(APP_ACTIONS.map(action => action.id)).size).toBe(APP_ACTIONS.length);
		for (const action of APP_ACTIONS) {
			expect(action.description.length, action.id).toBeGreaterThan(10);
			expect(action.args.additionalProperties).toBe(false);
			if (action.tier === "never") {
				expect(action.neverReason?.length, action.id).toBeGreaterThan(10);
				expect(action.run).toBeUndefined();
			} else expect(action.run, action.id).toBeDefined();
		}
	});

	it("makes every sensitive action decide, with a reason, whether agentControlManage lifts its card or it always asks", () => {
		for (const action of APP_ACTIONS) {
			if (action.tier === "sensitive") {
				const rule = action.manage;
				expect(rule, `${action.id} needs a manage rule (lifts or always, with the reason)`).toBeDefined();
				const reason = rule && ("always" in rule ? rule.always : rule.lifts);
				expect(reason?.length ?? 0, action.id).toBeGreaterThan(20);
			} else expect(action.manage, `${action.id} is not sensitive: no manage rule`).toBeUndefined();
		}
	});

	it("keeps its copies of the renderer's lists equal", () => {
		expect([...AGENT_PANEL_TABS]).toEqual([...PANEL_TABS]);
		expect([...AGENT_VIEW_SHEETS]).toEqual([...VIEW_SHEETS]);
		expect([...SETTINGS_SECTIONS]).toEqual([...SETTINGS_SECTION_IDS]);
	});

	it("gives every Settings catalog row an action or a reason, and no row both", () => {
		const rows = [
			...GUI_SEARCH_ITEMS.map(item => item.id),
			...Object.keys(CURATED_SCHEMA_ROWS),
			...Object.keys(CUSTOM_SCHEMA_EDITORS),
		];
		const missing = rows.filter(id => !SETTING_BY_ID[id] && !ROW_NOT_WRITTEN[id]);
		expect(missing).toEqual([]);
		expect(Object.keys(ROW_NOT_WRITTEN).filter(id => SETTING_BY_ID[id])).toEqual([]);
		for (const decision of Object.values(ROW_NOT_WRITTEN)) {
			if ("covered" in decision) expect(ACTION_BY_ID[decision.covered]).toBeDefined();
			else expect(decision.never.length).toBeGreaterThan(10);
		}
		for (const row of SETTINGS) expect(ACTION_BY_ID[settingActionId(row.id)]?.tier).toBe(row.tier);
	});

	it("offers no setting that gates the agent's own power", () => {
		for (const row of SETTINGS) {
			const key = row.kind === "pref" ? row.key : row.path;
			expect(key, row.id).not.toMatch(/agentControl|approval|approve|secrets|memory|computer|pstack|ecc|yolo/i);
		}
	});
});
