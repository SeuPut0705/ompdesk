/**
 * The extensions worker's pure decisions (resources/gui-bridge/stock-helper/extension-specs.ts) and the
 * plugin activation diff the bridge and the worker share (resources/gui-bridge/extensions/activation-core.ts).
 * No omp involved: stock's behaviour they mirror is exercised against the real omp in
 * stock-helper-extensions.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
	type ActivationPlugin,
	classifyActivation,
	pluginRequiresRestart,
} from "../../resources/gui-bridge/extensions/activation-core";
import {
	classifySkillOrigin,
	isExactSkillVersion,
	isLinkedSpec,
	isPinnedGitRef,
	isPinnedNpmSpec,
	isUnversionedInstall,
} from "../../resources/gui-bridge/stock-helper/extension-specs";

describe("isPinnedNpmSpec", () => {
	// What `bun install --no-cache <spec>` records in plugins/package.json (measured, bun 1.4.2): a bare name
	// and `@latest` record `^<latest>`, a dist-tag records `^<tagged version>`, the rest record themselves.
	it.each([
		["^1.2.3", "1.2.3", false],
		["^2.0.0-beta.1", "2.0.0-beta.1", false],
		["latest", "1.2.3", false],
		["*", "1.2.3", false],
		["", "1.2.3", false],
		[null, "1.2.3", false],
		["1.2.3", "1.2.3", true],
		["^1.0.0", "1.2.3", true],
		["~1.2.0", "1.2.3", true],
		["1", "1.2.3", true],
		["1.x", "1.2.3", true],
		[">=1.0.0", "1.2.3", true],
		["beta", "1.2.3", true],
		["^1.2.3", null, true],
	])("spec %j installed %j → pinned %j", (spec, installed, pinned) => {
		expect(isPinnedNpmSpec(spec, installed)).toBe(pinned);
	});

	it("trims the recorded spec", () => {
		expect(isPinnedNpmSpec("  latest ", "1.0.0")).toBe(false);
		expect(isPinnedNpmSpec(" ^1.0.0 ", "1.0.0")).toBe(false);
	});
});

describe("isPinnedGitRef", () => {
	it.each([
		[undefined, false],
		["", false],
		["main", false],
		["master", false],
		["develop", false],
		["feature/x", false],
		["abcdef1", true],
		["0123456789abcdef0123456789abcdef01234567", true],
		["v1.2.0", true],
		["1.2", true],
		["v2.0.0-rc.1", true],
		["abcdef", false],
		["latest", false],
	])("ref %j → pinned %j", (ref, pinned) => {
		expect(isPinnedGitRef(ref)).toBe(pinned);
	});
});

describe("isLinkedSpec / isUnversionedInstall", () => {
	it("recognizes stock's local-path specs, the ones PluginManager.upgrade refuses", () => {
		for (const spec of ["file:../x", "link:../x", "workspace:*", "portal:../x", "FILE:/abs"]) {
			expect(isLinkedSpec(spec)).toBe(true);
		}
		for (const spec of ["^1.0.0", "github:o/r", "https://example.com/x.git", "latest"]) {
			expect(isLinkedSpec(spec)).toBe(false);
		}
	});

	it("reads stock's 0.0.0 stand-in as a catalog that publishes no version", () => {
		expect(isUnversionedInstall("0.0.0")).toBe(true);
		expect(isUnversionedInstall("0.0.1")).toBe(false);
		expect(isUnversionedInstall(null)).toBe(false);
	});
});

describe("isExactSkillVersion", () => {
	// The cases of EXACT_VERSION_RE in stock's skillshare/installer.ts (not exported): an exact version rather
	// than a range or a dist-tag.
	it.each([
		["1.2.3", true],
		["v1.2.3", true],
		["1.2.3-beta.1", true],
		["1.2.3+build.5", true],
		["1.2.3-beta.1+build", true],
		["^1.2.3", false],
		["~1.2.3", false],
		["1.2", false],
		["1.x", false],
		["latest", false],
		["next", false],
		[">=1.0.0", false],
		["", false],
		[null, false],
		[undefined, false],
	])("range %j → exact %j", (range, exact) => {
		expect(isExactSkillVersion(range)).toBe(exact);
	});
});

describe("classifySkillOrigin", () => {
	it("splits skills into registry installs, plugin-provided and plain local files", () => {
		expect(classifySkillOrigin("skillshare", "@scope/pkg")).toBe("registry");
		expect(classifySkillOrigin("skillshare", undefined)).toBe("registry");
		for (const provider of ["claude-plugins", "agent-plugins", "omp-plugins"]) {
			expect(classifySkillOrigin(provider, undefined)).toBe("plugin");
		}
		expect(classifySkillOrigin("custom", "some-plugin")).toBe("plugin");
		for (const provider of ["native", "claude", "codex", "agents", "custom", "managed-skills", ""]) {
			expect(classifySkillOrigin(provider, undefined)).toBe("local");
		}
		expect(classifySkillOrigin("native", "")).toBe("local");
	});
});

describe("classifyActivation", () => {
	const plugin = (name: string, version: string, extra: Partial<ActivationPlugin> = {}): ActivationPlugin => ({
		name,
		version,
		path: `/plugins/${name}`,
		enabledFeatures: null,
		...extra,
	});
	const restartsFor =
		(...names: string[]) =>
		(p: ActivationPlugin) =>
			names.includes(p.name);

	it("is live when nothing changed or the changed plugin ships only commands and skills", () => {
		expect(classifyActivation([plugin("a", "1")], [plugin("a", "1")], restartsFor("a"))).toBe("live");
		expect(classifyActivation([plugin("a", "1")], [plugin("a", "2")], restartsFor("other"))).toBe("live");
	});

	it("needs a restart when a changed plugin on either side ships extensions, tools or hooks", () => {
		expect(classifyActivation([plugin("a", "1")], [plugin("a", "2")], restartsFor("a"))).toBe("restart-required");
		expect(classifyActivation([], [plugin("a", "1")], restartsFor("a"))).toBe("restart-required");
		expect(classifyActivation([plugin("a", "1")], [], restartsFor("a"))).toBe("restart-required");
	});

	it("sees a moved path or a different feature selection as a change, and feature order as none", () => {
		expect(classifyActivation([plugin("a", "1")], [plugin("a", "1", { path: "/elsewhere" })], restartsFor("a"))).toBe(
			"restart-required",
		);
		expect(
			classifyActivation(
				[plugin("a", "1", { enabledFeatures: ["x", "y"] })],
				[plugin("a", "1", { enabledFeatures: ["y"] })],
				restartsFor("a"),
			),
		).toBe("restart-required");
		expect(
			classifyActivation(
				[plugin("a", "1", { enabledFeatures: ["x", "y"] })],
				[plugin("a", "1", { enabledFeatures: ["y", "x"] })],
				restartsFor("a"),
			),
		).toBe("live");
		expect(
			classifyActivation(
				[plugin("a", "1", { enabledFeatures: null })],
				[plugin("a", "1", { enabledFeatures: [] })],
				restartsFor("a"),
			),
		).toBe("restart-required");
	});

	it("ignores unchanged restart-capable plugins next to a changed live one", () => {
		expect(
			classifyActivation(
				[plugin("a", "1"), plugin("b", "1")],
				[plugin("a", "1"), plugin("b", "2")],
				restartsFor("a"),
			),
		).toBe("live");
	});
});

describe("pluginRequiresRestart", () => {
	it("asks stock for the extension, tool and hook entries, and only those", () => {
		const asked: string[] = [];
		const resolve = (_plugin: object, key: string) => {
			asked.push(key);
			return key === "hooks" ? [{ entry: "h.ts" }] : [];
		};
		expect(pluginRequiresRestart({}, resolve)).toBe(true);
		expect(asked).toEqual(["extensions", "tools", "hooks"]);
		expect(pluginRequiresRestart({}, () => [])).toBe(false);
	});
});
