import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { SettingEntry } from "../../../shared/rpc-types";
import { conditionParent, isSettingVisible } from "./settings-schema-utils";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
// Gate on the exact modules evaluated below: a CI runner can carry the package
// directory without its sources, and an older omp may lay them out differently.
const stockAvailable = ["settings.ts", "settings-ui.ts", "all-settings.ts"].every(file =>
	existsSync(path.join(stockRoot, "src", "config", file)),
);

const gated = (condition: string): SettingEntry => ({
	path: "x",
	type: "boolean",
	value: false,
	default: false,
	condition,
});

/** Stock gates that read the host or a config layer, never a setting value: the GUI keeps them visible. */
const HOST_GATES = [
	"macOS",
	"hasImageProtocol",
	"nativeRendering",
	"contextFilesExtraNotProject",
	"restrictedFoldersNotProject",
];

/** Gates of stock's own memory settings, which OMPdesk does not list (ai-memory replaced them), so it has no rule for them. */
const UNLISTED_GATES = ["hindsightActive", "mnemopiActive", "autolearnActive"];
/** Each settings-backed gate with the value combinations that flip it. */
const CASES: Record<string, Record<string, unknown>[]> = {
	advisorEnabled: [{ "advisor.enabled": true }, { "advisor.enabled": false }],
	autoThinkingActive: [{ defaultThinkingLevel: "auto" }, { defaultThinkingLevel: "high" }],
	usageAwareFallbackEnabled: [{ "retry.usageAwareFallback": true }, { "retry.usageAwareFallback": false }],
	planModeEnabled: [{ "plan.enabled": true }, { "plan.enabled": false }],
	vimModeEnabled: [{ "tui.vimMode": true }, { "tui.vimMode": false }],
	planAutosaveEnabled: [
		{ "plan.enabled": true, "plan.autosave": true },
		{ "plan.enabled": true, "plan.autosave": false },
		{ "plan.enabled": false, "plan.autosave": true },
	],
};

interface StockConditions {
	/** Every condition name a registered setting declares. */
	names: string[];
	/** Stock's verdict per CASES entry, in order. */
	results: Record<string, boolean[]>;
}

function stockConditions(): StockConditions {
	// Stock reads Bun-native modules and its global settings instance; evaluate it in Bun.
	const result = spawnSync(
		"bun",
		[
			"--eval",
			`
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const root = ${JSON.stringify(stockRoot)};
		const { Settings, resetSettingsForTest } = await import(root + "/src/config/settings.ts");
		const { createSettingsHost } = await import(root + "/src/config/settings-ui.ts");
		const { orderedSettings } = await import(root + "/src/config/all-settings.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-conditions-"));
		const nameOf = new Map(orderedSettings().map(setting => [setting.id, setting.ui?.condition]));
		const gates = new Map();
		for (const entry of createSettingsHost().entries) {
			const name = nameOf.get(entry.path);
			if (name && entry.condition && !gates.has(name)) gates.set(name, entry.condition);
		}
		const results = {};
		for (const [name, cases] of Object.entries(${JSON.stringify(CASES)})) {
			results[name] = [];
			for (const overrides of cases) {
				resetSettingsForTest();
				await Settings.init({ inMemory: true, agentDir: dir, cwd: dir, overrides });
				results[name].push(gates.get(name)?.() ?? null);
			}
		}
		fs.rmSync(dir, { recursive: true, force: true });
		console.log(JSON.stringify({ names: [...gates.keys()], results }));
	`,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr);
	return JSON.parse(result.stdout) as StockConditions;
}

describe.skipIf(!stockAvailable)("settings condition gates against installed stock", () => {
	// A skipped describe still runs its body while collecting; only hooks and tests are skipped.
	let stock: StockConditions = { names: [], results: {} };
	beforeAll(() => {
		stock = stockConditions();
	});

	it("covers every stock condition as a settings-backed gate or a host gate", () => {
		expect(stock.names.filter(name => !HOST_GATES.includes(name) && !UNLISTED_GATES.includes(name)).sort()).toEqual(
			Object.keys(CASES).sort(),
		);
	});

	it.each(Object.keys(CASES))("evaluates %s like stock", name => {
		const cases = CASES[name] ?? [];
		const gui = cases.map(values => isSettingVisible(gated(name), values));
		expect(gui).toEqual(stock.results[name]);
		expect(conditionParent(name)).toBeDefined();
	});

	it("keeps host gates visible", () => {
		for (const name of HOST_GATES) {
			expect(isSettingVisible(gated(name), {})).toBe(true);
		}
	});
});
