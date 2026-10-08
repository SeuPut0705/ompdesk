/**
 * gui-bridge thinking default (resources/gui-bridge/thinking-default-core.ts)
 * against a fake of stock's layered Settings: OMPdesk's sessions start on `auto`
 * while no layer sets `defaultThinkingLevel`, and any level the user set — in
 * config.yml, a project config, or later through Settings — wins and persists.
 */
import { describe, expect, it } from "vitest";
import {
	applyThinkingDefault,
	asThinkingDefaultSetting,
	configuredIn,
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

/** The `defaultThinkingLevel` handle with stock's `Setting` semantics, plus `get` and `set` (a global write). */
interface FakeHandle extends ThinkingDefaultSetting {
	get(scope: FakeSettings): unknown;
	set(scope: FakeSettings, value: string | undefined): void;
}

const setting: FakeHandle = {
	id: "defaultThinkingLevel",
	segments: ["defaultThinkingLevel"],
	get(scope: FakeSettings): unknown {
		return (
			scope.overrides.defaultThinkingLevel ??
			scope.project.defaultThinkingLevel ??
			scope.global.defaultThinkingLevel ??
			"high"
		);
	},
	set(scope: FakeSettings, value: string | undefined): void {
		if (value === undefined) delete scope.global.defaultThinkingLevel;
		else scope.global.defaultThinkingLevel = value;
	},
	isConfigured(scope: object): boolean {
		const settings = scope as FakeSettings;
		return [settings.overrides, settings.project, settings.global].some(layer =>
			configuredIn(layer, ["defaultThinkingLevel"]),
		);
	},
	override(scope: object, value: string): void {
		(scope as FakeSettings).overrides.defaultThinkingLevel = value;
	},
	clearOverride(scope: object): void {
		delete (scope as FakeSettings).overrides.defaultThinkingLevel;
	},
};

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
});
