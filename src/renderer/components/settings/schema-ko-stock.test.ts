import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelRoleName } from "./schema-i18n";
import { KO_GROUP_TITLES, KO_SETTINGS } from "./schema-ko";
import { KO_SCHEMA_OPTION_TEXT } from "./schema-option-ko";
import { isSettingSupportedInGui } from "./settings-schema-utils";

const stock = join(homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/all-settings.ts");
interface StockText {
	id: string;
	label: string;
	description?: string;
	tab?: string;
	group?: string;
	options: { label: string; description?: string }[];
}

// Stock's Bun/native dependencies cannot run in Vitest's Node worker. Collect
// the same text as gui-bridge/settings.ts, including Advanced and enum fallback.
describe.skipIf(!existsSync(stock))("Korean coverage of installed stock settings", () => {
	it("has an explicit Korean entry for every UI setting, group and option text", () => {
		const dir = mkdtempSync(join(tmpdir(), "ompdesk-stock-settings-"));
		try {
			const output = join(dir, "settings.json");
			execFileSync(
				"bun",
				[
					"-e",
					`
import { orderedSettings } from ${JSON.stringify(stock)};
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(output)}, JSON.stringify(orderedSettings().map(setting => ({
 id: setting.id,
 tab: typeof setting.ui?.tab === "string" ? setting.ui.tab : undefined,
 label: typeof setting.ui?.label === "string" ? setting.ui.label : setting.id,
 description: typeof setting.ui?.description === "string" ? setting.ui.description : undefined,
 group: typeof setting.ui?.group === "string" ? setting.ui.group : undefined,
 options: Array.isArray(setting.ui?.options)
  ? setting.ui.options.map(option => ({label: String(option.label ?? option.value), description: typeof option.description === "string" ? option.description : undefined}))
  : (setting.enumValues ?? []).map(value => ({label: value}))
}))));`,
				],
				{ encoding: "utf8", timeout: 30_000 },
			);
			const entries: StockText[] = JSON.parse(readFileSync(output, "utf8"));
			const missing: string[] = [];
			for (const entry of entries) {
				// Settings the GUI never lists (terminal-only rows, stock's memory backends) need no Korean text.
				if (!isSettingSupportedInGui({ path: entry.id, tab: entry.tab })) continue;
				if (!KO_SETTINGS[entry.id]?.label) missing.push(`${entry.id}: label (${entry.label})`);
				if (entry.description && !KO_SETTINGS[entry.id]?.description) missing.push(`${entry.id}: description`);
				if (entry.group && !KO_GROUP_TITLES[entry.group]) missing.push(`group: ${entry.group}`);
				for (const option of entry.options) {
					for (const text of [option.label, option.description]) {
						if (text && !KO_SCHEMA_OPTION_TEXT[text]) missing.push(`${entry.id}: option (${text})`);
					}
				}
			}
			expect(entries.length).toBeGreaterThan(0);
			expect([...new Set(missing)]).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("has a Korean name for every built-in model role stock names", () => {
		const roles = join(stock, "..", "model-roles.ts");
		const names: string[] = JSON.parse(
			execFileSync(
				"bun",
				[
					"-e",
					`import { MODEL_ROLES } from ${JSON.stringify(roles)}; console.log(JSON.stringify(Object.values(MODEL_ROLES).map(role => role.name)));`,
				],
				{ encoding: "utf8", timeout: 30_000 },
			),
		);
		expect(names.length).toBeGreaterThan(0);
		expect(names.filter(name => modelRoleName("ko", name) === name)).toEqual([]);
		expect(names.every(name => modelRoleName("en", name) === name)).toBe(true);
	});
});

describe("Korean role names", () => {
	it("gives a role the same name whichever stock name it comes under, so Settings and the setup dialog agree", () => {
		expect(modelRoleName("ko", "Architect")).toBe(modelRoleName("ko", "Plan"));
		expect(modelRoleName("ko", "Commit")).toBe(modelRoleName("ko", "Commit messages"));
	});
});
