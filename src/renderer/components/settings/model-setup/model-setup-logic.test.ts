/**
 * Model setup assistant logic: the offered models are the connected
 * accounts' chat candidates, the preselection is the default model plus the
 * strongest model of each other provider, and only real changes are written.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelInfo, ModelRoleCandidate, ModelRoleEntry } from "../../../../shared/rpc-types";
import {
	baseSelector,
	changedAssignments,
	currentDefaultModel,
	defaultSelection,
	effectiveAdvisorModel,
	setupModelOptions,
	setupRoles,
} from "./model-setup-logic";

const candidate = (provider: string, id: string, kind: ModelRoleCandidate["kind"] = "chat"): ModelRoleCandidate => ({
	provider,
	id,
	name: id,
	kind,
});
const CANDIDATES = [
	candidate("anthropic", "claude-opus-4-1"),
	candidate("anthropic", "claude-sonnet-4-5"),
	candidate("openai", "gpt-5-mini"),
	candidate("openai", "gpt-5.2"),
	candidate("google", "gemini-3-pro"),
	candidate("openai", "gpt-image-1", "image"),
];
const role = (id: string, partial: Partial<ModelRoleEntry> = {}): ModelRoleEntry => ({
	id,
	name: id,
	section: "chat",
	source: "settings",
	candidates: CANDIDATES,
	...partial,
});
const CATALOG: ModelInfo[] = [
	{ provider: "anthropic", id: "claude-opus-4-1", int: 70, contextWindow: 200_000, cost: { input: 15, output: 75 } },
	{ provider: "openai", id: "gpt-5-mini", int: 50, cost: { input: 0.25, output: 2 } },
	{ provider: "openai", id: "gpt-5.2", int: 68, cost: { input: 1.25, output: 10 } },
];
const ROLES = [
	role("default", { model: "anthropic/claude-sonnet-4-5:high" }),
	role("smol"),
	role("slow", { model: "anthropic/claude-opus-4-1" }),
	role("advisor"),
	role("hidden", { hidden: true }),
	role("specialist", { model: "openai-codex/gpt-6.1-sol" }),
	role("image", { section: "kind" }),
];

describe("model setup logic", () => {
	it("offers the chat candidates with catalog facts", () => {
		const options = setupModelOptions(ROLES, CATALOG);
		expect(options.map(option => option.selector)).toEqual([
			"anthropic/claude-opus-4-1",
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-5-mini",
			"openai/gpt-5.2",
			"google/gemini-3-pro",
		]);
		expect(options[0]).toMatchObject({ contextWindow: 200_000, cost: { input: 15, output: 75 }, intelligence: 70 });
	});

	it("preselects the default model and the strongest model of each other provider", () => {
		const options = setupModelOptions(ROLES, CATALOG);
		const defaultModel = currentDefaultModel(ROLES, options, null);
		expect(defaultModel).toBe("anthropic/claude-sonnet-4-5");
		expect(defaultSelection(options, defaultModel)).toEqual([
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-5.2",
			"google/gemini-3-pro",
		]);
		// No default role: the session's model stands in.
		const noDefault = [role("default"), ...ROLES.slice(1)];
		expect(currentDefaultModel(noDefault, options, { provider: "openai", id: "gpt-5-mini" })).toBe(
			"openai/gpt-5-mini",
		);
	});

	it("researches the visible built-in chat roles only, never a custom role the user defined", () => {
		expect(setupRoles(ROLES).map(entry => entry.id)).toEqual(["default", "smol", "slow", "advisor"]);
	});

	it("writes only roles whose model changes, whatever their thinking suffix", () => {
		expect(baseSelector("ollama/llama3:8b")).toBe("ollama/llama3:8b");
		expect(baseSelector("openai/gpt-5.2:xhigh")).toBe("openai/gpt-5.2");
		expect(
			changedAssignments(
				{
					default: "anthropic/claude-sonnet-4-5",
					smol: "openai/gpt-5-mini",
					slow: "anthropic/claude-opus-4-1",
					advisor: "openai/gpt-5.2",
				},
				ROLES,
			),
		).toEqual([
			{ role: "smol", model: "openai/gpt-5-mini" },
			{ role: "advisor", model: "openai/gpt-5.2" },
		]);
	});

	it("names the model the advisor runs on, falling back to the Thinking role", () => {
		expect(effectiveAdvisorModel(ROLES)).toEqual({ model: "anthropic/claude-opus-4-1", via: "slow" });
		expect(effectiveAdvisorModel([role("advisor", { model: "openai/gpt-5.2" }), ...ROLES])).toEqual({
			model: "openai/gpt-5.2",
			via: "advisor",
		});
		expect(effectiveAdvisorModel([role("default")])).toBeUndefined();
	});
});

const stockSelector = path.join(
	os.homedir(),
	".bun/install/global/node_modules/@oh-my-pi/pi-tui/src/overlays/model-selector.ts",
);

describe.skipIf(!existsSync(stockSelector))("baseSelector against installed stock", () => {
	it("strips the same suffixes as stock splitThinkingSuffix with every effort selector enabled", () => {
		const selectors = [
			"openai/gpt-5.2:xhigh",
			"p/m:off",
			"p/m:minimal",
			"p/m:low",
			"p/m:medium",
			"p/m:high",
			"p/m:max",
			"p/m:auto",
			"p/m",
			"ollama/llama3:8b",
			"p/m:HIGH",
		];
		// Stock imports Bun-native modules; evaluate it in Bun.
		const result = spawnSync(
			"bun",
			[
				"--eval",
				`const { splitThinkingSuffix, MAX_THINKING_SUFFIX_OPTIONS } = await import(${JSON.stringify(stockSelector)});
				console.log(JSON.stringify(${JSON.stringify(selectors)}.map(s => splitThinkingSuffix(s, -1, MAX_THINKING_SUFFIX_OPTIONS).base)));`,
			],
			{ encoding: "utf8" },
		);
		if (result.status !== 0) throw new Error(result.stderr);
		expect(selectors.map(baseSelector)).toEqual(JSON.parse(result.stdout));
	});
});
