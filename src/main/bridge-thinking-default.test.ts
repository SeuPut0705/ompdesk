/**
 * gui-bridge thinking defaults (resources/gui-bridge/thinking-default-core.ts)
 * against a fake of stock's layered Settings: OMPdesk's sessions start on `auto`
 * with the auto classifier allowed up to `max` while no layer sets those
 * settings, and any value the user set — in config.yml, a project config, or
 * later through Settings — wins and persists.
 */
import { describe, expect, it } from "vitest";
import {
	applyThinkingDefault,
	asThinkingDefaultSetting,
	configuredIn,
	GUI_THINKING_DEFAULTS,
	NATIVE_DEFAULTS,
	releaseThinkingDefault,
	settleThinkingDefault,
	type ThinkingDefaultSetting,
} from "../../resources/gui-bridge/thinking-default-core";

type Layer = Record<string, unknown>;

/** Stock's precedence: runtime override → project → global (config.yml) → schema default `high`. */
interface FakeSettings {
	global: Layer;
	project: Layer;
	overrides: Layer;
}

const fakeSettings = (global: Layer = {}, project: Layer = {}): FakeSettings => ({ global, project, overrides: {} });

/** A setting handle with stock's `Setting` semantics, plus `get` and `set` (a global write). */
interface FakeHandle extends ThinkingDefaultSetting {
	get(scope: FakeSettings): unknown;
	set(scope: FakeSettings, value: string | undefined): void;
}

function fakeHandle(id: string, stockDefault: string): FakeHandle {
	return {
		id,
		segments: [id],
		get(scope: FakeSettings): unknown {
			return scope.overrides[id] ?? scope.project[id] ?? scope.global[id] ?? stockDefault;
		},
		set(scope: FakeSettings, value: string | undefined): void {
			if (value === undefined) delete scope.global[id];
			else scope.global[id] = value;
		},
		isConfigured(scope: object): boolean {
			const settings = scope as FakeSettings;
			return [settings.overrides, settings.project, settings.global].some(layer => configuredIn(layer, [id]));
		},
		override(scope: object, value: string): void {
			(scope as FakeSettings).overrides[id] = value;
		},
		clearOverride(scope: object): void {
			delete (scope as FakeSettings).overrides[id];
		},
	};
}

const setting = fakeHandle("defaultThinkingLevel", "high");
const ceiling = fakeHandle("providers.autoThinkingMaxEffort", "xhigh");

const persisted = (scope: FakeSettings) =>
	configuredIn(scope.global, setting.segments) || configuredIn(scope.project, setting.segments);

/** set_setting's order: release the default, write config.yml, then settle. */
function userWrites(scope: FakeSettings, value: string | undefined): void {
	releaseThinkingDefault(setting, scope);
	setting.set(scope, value);
	settleThinkingDefault(setting, scope, persisted(scope));
}

describe("gui-bridge thinking default", () => {
	it("starts on auto while no layer sets the level, without writing config.yml", () => {
		const scope = fakeSettings();
		expect(applyThinkingDefault(setting, scope)).toBe(true);
		expect(setting.get(scope)).toBe("auto");
		expect(scope.global).toEqual({});
		expect(scope.overrides).toEqual({ defaultThinkingLevel: "auto" });
	});

	it("keeps an explicit high from config.yml", () => {
		const scope = fakeSettings({ defaultThinkingLevel: "high" });
		expect(applyThinkingDefault(setting, scope)).toBe(false);
		expect(setting.get(scope)).toBe("high");
		expect(scope.overrides).toEqual({});
	});

	it("keeps an explicit auto from config.yml as the user's own value", () => {
		const scope = fakeSettings({ defaultThinkingLevel: "auto" });
		expect(applyThinkingDefault(setting, scope)).toBe(false);
		expect(setting.get(scope)).toBe("auto");
		expect(scope.overrides).toEqual({});
	});

	it("keeps a level a project config sets", () => {
		const scope = fakeSettings({}, { defaultThinkingLevel: "low" });
		expect(applyThinkingDefault(setting, scope)).toBe(false);
		expect(setting.get(scope)).toBe("low");
	});

	it("lets a later Settings write win and persist, and a reset bring auto back", () => {
		const scope = fakeSettings();
		applyThinkingDefault(setting, scope);
		userWrites(scope, "high");
		expect(setting.get(scope)).toBe("high");
		expect(scope.global).toEqual({ defaultThinkingLevel: "high" });
		expect(scope.overrides).toEqual({});

		userWrites(scope, undefined);
		expect(setting.get(scope)).toBe("auto");
		expect(scope.global).toEqual({});
		expect(scope.overrides).toEqual({ defaultThinkingLevel: "auto" });
	});

	it("persists auto picked in Settings as the user's value instead of the runtime default", () => {
		const scope = fakeSettings();
		applyThinkingDefault(setting, scope);
		userWrites(scope, "auto");
		expect(setting.get(scope)).toBe("auto");
		expect(scope.global).toEqual({ defaultThinkingLevel: "auto" });
		expect(scope.overrides).toEqual({});
	});

	it("yields to a level written into config.yml while the default is held", () => {
		const scope = fakeSettings();
		applyThinkingDefault(setting, scope);
		scope.global.defaultThinkingLevel = "medium";
		settleThinkingDefault(setting, scope, persisted(scope));
		expect(setting.get(scope)).toBe("medium");
		expect(scope.overrides).toEqual({});
	});

	it("leaves a stock-like handle without the override methods alone", () => {
		expect(asThinkingDefaultSetting(setting)).toBe(setting);
		expect(asThinkingDefaultSetting({ id: "defaultThinkingLevel", segments: [], get() {} })).toBeUndefined();
		expect(asThinkingDefaultSetting(undefined)).toBeUndefined();
	});

	it("lets auto reach the model's top effort unless the user capped it", () => {
		const scope = fakeSettings();
		applyThinkingDefault(setting, scope);
		expect(applyThinkingDefault(ceiling, scope)).toBe(true);
		expect(ceiling.get(scope)).toBe("max");
		expect(scope.global).toEqual({});

		const capped = fakeSettings({ "providers.autoThinkingMaxEffort": "xhigh" });
		expect(applyThinkingDefault(ceiling, capped)).toBe(false);
		expect(ceiling.get(capped)).toBe("xhigh");
	});

	it("releases one default without touching the other on the same Settings", () => {
		const scope = fakeSettings();
		applyThinkingDefault(setting, scope);
		applyThinkingDefault(ceiling, scope);
		releaseThinkingDefault(setting, scope);
		setting.set(scope, "high");
		expect(setting.get(scope)).toBe("high");
		expect(ceiling.get(scope)).toBe("max");
		expect(scope.overrides).toEqual({ "providers.autoThinkingMaxEffort": "max" });
	});
});

/**
 * `advisor.enabled`: stock soft-pins it to false for RPC hosts, a runtime override that makes it read as
 * configured. `layers` in the fake mirror `getProvenance` (runtime → project → global).
 */
function fakeAdvisor(id = "advisor.enabled"): ThinkingDefaultSetting & { get(scope: FakeSettings): unknown } {
	return {
		id,
		segments: [id],
		default: false,
		get: (scope: FakeSettings) => scope.overrides[id] ?? scope.project[id] ?? scope.global[id] ?? false,
		provenance(scope: object): string {
			const settings = scope as FakeSettings;
			if (id in settings.overrides) return "runtime";
			if (id in settings.project) return "project";
			return id in settings.global ? "global" : "default";
		},
		isConfigured(scope: object): boolean {
			const settings = scope as FakeSettings;
			return [settings.overrides, settings.project, settings.global].some(layer => configuredIn(layer, [id]));
		},
		override(scope: object, value: unknown): void {
			(scope as FakeSettings).overrides[id] = value;
		},
		clearOverride(scope: object): void {
			delete (scope as FakeSettings).overrides[id];
		},
	};
}

describe("gui-bridge held stock defaults", () => {
	it("holds the settings OMPdesk turns on, and none of the ones stock reads before extensions load", () => {
		expect(GUI_THINKING_DEFAULTS).toMatchObject({
			"display.showTokenUsage": true,
			"lsp.diagnosticsOnEdit": true,
			"lsp.formatOnWrite": true,
			"astGrep.enabled": true,
			"advisor.enabled": true,
		});
		for (const path of [
			"telemetry.otlpExportEnabled",
			"display.showTurnTime",
			"read.toolResultPreview",
			"astEdit.enabled",
			"retry.usageAwareFallback",
			"retry.waitForUsageReset",
		]) {
			expect(Object.keys(GUI_THINKING_DEFAULTS), path).not.toContain(path);
		}
		expect(NATIVE_DEFAULTS).toEqual({ "astGrep.enabled": "astGrep" });
	});

	it("takes over stock's protocol pin, which is no layer's value", () => {
		const advisor = fakeAdvisor();
		const scope = fakeSettings();
		scope.overrides["advisor.enabled"] = false; // applyProtocolDefaults("rpc")
		expect(applyThinkingDefault(advisor, scope, false)).toBe(true);
		expect(advisor.get(scope)).toBe(true);
		expect(scope.global).toEqual({});
	});

	it("does not take over a pin when a persisted layer sets it, whatever its value", () => {
		const advisor = fakeAdvisor();
		const scope = fakeSettings({ "advisor.enabled": false });
		scope.overrides["advisor.enabled"] = false;
		expect(applyThinkingDefault(advisor, scope, true)).toBe(false);
		expect(advisor.get(scope)).toBe(false);
	});

	it("leaves a runtime value other than the pin alone", () => {
		const advisor = fakeAdvisor();
		const scope = fakeSettings();
		scope.overrides["advisor.enabled"] = "custom"; // some other runtime override, not the pin's default
		expect(applyThinkingDefault(advisor, scope, false)).toBe(false);
		expect(advisor.get(scope)).toBe("custom");
	});

	it("takes over only a pinned-class setting: other settings that are configured stay as they are", () => {
		const lsp = fakeAdvisor("lsp.formatOnWrite");
		const scope = fakeSettings();
		scope.overrides["lsp.formatOnWrite"] = false;
		expect(applyThinkingDefault(lsp, scope, false)).toBe(false);
	});

	it("refuses a pinned-class handle that cannot report its provenance", () => {
		const { provenance: _provenance, ...partial } = fakeAdvisor();
		expect(asThinkingDefaultSetting(partial)).toBeUndefined();
		expect(asThinkingDefaultSetting(fakeAdvisor())).toBeDefined();
	});

	it("releases on a Settings write and takes the default up again on a reset", () => {
		const advisor = fakeAdvisor();
		const scope = fakeSettings();
		scope.overrides["advisor.enabled"] = false;
		applyThinkingDefault(advisor, scope, false);
		releaseThinkingDefault(advisor, scope);
		scope.global["advisor.enabled"] = false; // the user's write
		settleThinkingDefault(advisor, scope, true);
		expect(advisor.get(scope)).toBe(false);
		expect(advisor.provenance?.(scope)).toBe("global");

		delete scope.global["advisor.enabled"]; // reset: stock's pin is gone with the write
		settleThinkingDefault(advisor, scope, false);
		expect(advisor.get(scope)).toBe(true);
		expect(advisor.provenance?.(scope)).toBe("runtime");
	});

	it("holds plain boolean defaults like the thinking level: explicit values win, writes release", () => {
		const tokens = fakeAdvisor("display.showTokenUsage");
		const scope = fakeSettings();
		expect(applyThinkingDefault(tokens, scope, false)).toBe(true);
		expect(tokens.get(scope)).toBe(true);
		expect(scope.global).toEqual({});
		const explicit = fakeSettings({ "display.showTokenUsage": false });
		expect(applyThinkingDefault(tokens, explicit, true)).toBe(false);
		expect(tokens.get(explicit)).toBe(false);
	});
});
