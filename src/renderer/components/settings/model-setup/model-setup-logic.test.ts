/**
 * Model setup assistant logic: the picker offers the default pool's chat models plus the judge role's judge-kind
 * models with their billing class, quota headroom reads the roomiest unlimited account, research overlays only
 * models the pool and the role allow, Undo restores only roles nobody changed since, and an old prefs record
 * reads as nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSetupFacts } from "../../../../../resources/gui-bridge/model-setup-contracts";
import type { ModelSetupPlan } from "../../../../shared/model-setup";
import { baseSelector, type PlanRow } from "../../../../shared/role-plan";
import type { ModelRoleCandidate, ModelRoleEntry, UsageReport } from "../../../../shared/rpc-types";
import { translate } from "../../../lib/i18n";
import {
	type AppliedSetup,
	currentDefaultModel,
	distinctModels,
	effectiveAdvisorModel,
	loadSetupRecord,
	MODEL_SETUP_PREFS_KEY,
	mergeApplied,
	offersNewSetup,
	parseSetupFacts,
	planRoleInputs,
	reasonText,
	researchEstimate,
	researchPool,
	researchRequest,
	saveSetupRecord,
	setupModelOptions,
	undoSteps,
	usageHeadroom,
	withResearch,
} from "./model-setup-logic";

const candidate = (provider: string, id: string, kind: ModelRoleCandidate["kind"] = "chat"): ModelRoleCandidate => ({
	provider,
	id,
	name: id,
	kind,
});
const CHAT = [
	candidate("anthropic", "opus"),
	candidate("anthropic", "haiku"),
	candidate("openrouter", "deepseek"),
	candidate("openai", "dalle", "image"),
];
const role = (id: string, partial: Partial<ModelRoleEntry> = {}): ModelRoleEntry => ({
	id,
	name: id,
	section: "chat",
	source: "settings",
	candidates: CHAT,
	...partial,
});
const ROLES = [
	role("default", { model: "anthropic/opus:high" }),
	role("smol"),
	role("secret", { hidden: true }),
	role("judge", {
		section: "kind",
		candidates: [candidate("jev", "jev-1.14", "judge"), candidate("jev", "jev-latest", "judge")],
	}),
];
const FACTS: ModelSetupFacts = {
	providers: {
		anthropic: { billing: "subscription", basis: "oauth" },
		openrouter: { billing: "metered", basis: "api-key" },
		jev: { billing: "metered", basis: "api-key" },
	},
	models: {
		"anthropic/opus": {
			provider: "anthropic",
			id: "opus",
			name: "Opus",
			kind: "chat",
			int: 80,
			outputPrice: 25,
			inputPrice: 5,
			image: true,
		},
		"anthropic/haiku": {
			provider: "anthropic",
			id: "haiku",
			name: "Haiku",
			kind: "chat",
			int: 60,
			outputPrice: 5,
			inputPrice: 1,
			image: false,
		},
		"openrouter/deepseek": {
			provider: "openrouter",
			id: "deepseek",
			name: "DeepSeek",
			kind: "chat",
			int: 62,
			outputPrice: 1,
			inputPrice: 0.3,
			image: false,
		},
		"jev/jev-1.14": { provider: "jev", id: "jev-1.14", name: "Jev 1.14", kind: "judge", image: false },
	},
	roles: {},
	judgePins: ["jev/jev-1.14"],
};

describe("model setup logic", () => {
	it("offers the default pool's chat models and the judge role's judge models, with billing, only those the facts describe", () => {
		const options = setupModelOptions(ROLES, FACTS);
		expect(options.map(option => [option.selector, option.kind, option.billing])).toEqual([
			["anthropic/opus", "chat", "subscription"],
			["anthropic/haiku", "chat", "subscription"],
			["openrouter/deepseek", "chat", "metered"],
			["jev/jev-1.14", "judge", "metered"],
		]);
	});

	it("takes the default role's model (thinking suffix dropped), else the session's, as the current default", () => {
		const options = setupModelOptions(ROLES, FACTS);
		expect(currentDefaultModel(ROLES, options, null)).toBe("anthropic/opus");
		const noDefault = [role("default"), ...ROLES.slice(1)];
		expect(currentDefaultModel(noDefault, options, { provider: "anthropic", id: "haiku" })).toBe("anthropic/haiku");
	});

	it("feeds the planner every listed role, hidden ones flagged", () => {
		expect(
			planRoleInputs(ROLES).map(entry => [entry.id, entry.section, entry.hidden ?? false, entry.current]),
		).toEqual([
			["default", "chat", false, "anthropic/opus:high"],
			["smol", "chat", false, undefined],
			["secret", "chat", true, undefined],
			["judge", "kind", false, undefined],
		]);
		expect(planRoleInputs(ROLES)[0]?.candidates).toEqual([
			"anthropic/opus",
			"anthropic/haiku",
			"openrouter/deepseek",
			"openai/dalle",
		]);
	});

	it("reads quota headroom as the roomiest unlimited account's tightest window", () => {
		const now = 1_000;
		const report = (provider: string, limits: UsageReport["limits"], resetAt?: number): UsageReport => ({
			provider,
			fetchedAt: 0,
			limits,
			...(resetAt !== undefined ? { resetAt } : {}),
		});
		const reports = [
			report("openai", [
				{ id: "5h", label: "5h", usedFraction: 0.9 },
				{ id: "7d", label: "7d", remainingFraction: 0.5 },
			]),
			report("openai", [{ id: "5h", label: "5h", usedFraction: 0.2 }]),
			// Limited until later: counts for nothing.
			report("openai", [{ id: "5h", label: "5h", usedFraction: 0 }], 5_000),
			report("anthropic", [{ id: "5h", label: "5h", usedFraction: 1 }]),
			report("google", [{ id: "x", label: "x" }]),
		];
		expect(usageHeadroom(reports, now)).toEqual({ openai: 0.8, anthropic: 0 });
		expect(usageHeadroom(null, now)).toEqual({});
	});

	it("lists the distinct models a plan chose", () => {
		const row = (role: string, model: string | null): PlanRow => ({
			role,
			model,
			manual: false,
			follows: false,
			checked: false,
			reason: { rule: "chat" },
		});
		expect(distinctModels([row("a", "p/x"), row("b", null), row("c", "p/y"), row("d", "p/x")])).toEqual([
			"p/x",
			"p/y",
		]);
	});

	it("words the cheap rule with its numbers and billing; the picked mode adds why a provider is metered", () => {
		const row: PlanRow = {
			role: "smol",
			model: "anthropic/haiku",
			manual: false,
			follows: false,
			checked: true,
			reason: {
				rule: "cheap",
				billing: "subscription",
				basis: "oauth",
				int: 60,
				topInt: 80,
				outputPrice: 5,
				comparePrice: 25,
				headroom: 0.6,
			},
		};
		expect(reasonText(translate, row, { mode: "full", keepsDefault: false })).toBe(
			"Cheapest model within 70% of the top intelligence: int 60 of 80, $5/M output vs $25/M. Subscription. About 60% of this account's usage is left.",
		);
		const metered = {
			...row,
			reason: { rule: "chat" as const, billing: "metered" as const, basis: "api-key" as const },
		};
		expect(reasonText(translate, metered, { mode: "picked", keepsDefault: false })).toBe(
			"Follows the default role's model. Metered (billed per use): billed through a stored API key.",
		);
		expect(
			reasonText(
				translate,
				{ ...row, reason: { rule: "advisor", crossVendor: true } },
				{ mode: "full", keepsDefault: false },
			),
		).toContain("from a different vendor");
		expect(reasonText(translate, row, { mode: "picked", keepsDefault: false, research: "Best on SWE-bench." })).toBe(
			"Best on SWE-bench. Subscription: signed in with your account.",
		);
	});

	it("estimates a research run from the model's list prices and says who pays", () => {
		expect(researchEstimate(FACTS, "anthropic/opus")).toEqual({ billing: "subscription", usd: 0.625 });
		expect(researchEstimate(FACTS, "openrouter/deepseek").billing).toBe("metered");
		expect(researchEstimate(FACTS, "jev/jev-1.14")).toEqual({ billing: "metered" });
	});

	it("builds the research request from the pool and the chat roles get_model_roles lists", () => {
		const options = setupModelOptions(ROLES, FACTS);
		expect(researchPool(options, FACTS, "full", [])).toEqual(["anthropic/opus", "anthropic/haiku"]);
		expect(researchPool(options, FACTS, "picked", ["openrouter/deepseek", "jev/jev-1.14"])).toEqual([
			"openrouter/deepseek",
		]);
		const rows: PlanRow[] = ["default", "smol", "judge"].map(id => ({
			role: id,
			model: null,
			manual: false,
			follows: false,
			checked: false,
			reason: { rule: "stock" },
		}));
		const request = researchRequest({
			researchModel: "anthropic/opus",
			defaultModel: "anthropic/opus",
			pool: ["anthropic/opus"],
			facts: FACTS,
			roles: ROLES,
			rows,
			language: "English",
		});
		expect(request.roles).toEqual([
			{ id: "default", name: "default", section: "chat" },
			{ id: "smol", name: "smol", section: "chat" },
		]);
		expect(request.models).toEqual([
			{
				selector: "anthropic/opus",
				provider: "anthropic",
				name: "Opus",
				cost: { input: 5, output: 25 },
				intelligence: 80,
			},
		]);
	});

	it("lays a research plan over a row only when its model is in the pool and a candidate of the role", () => {
		const rows: PlanRow[] = [
			{
				role: "default",
				model: "anthropic/opus",
				current: "anthropic/opus",
				manual: false,
				follows: false,
				checked: false,
				reason: { rule: "default" },
			},
			{
				role: "smol",
				model: "anthropic/haiku",
				manual: false,
				follows: false,
				checked: true,
				reason: { rule: "cheap" },
			},
			{ role: "image", model: null, manual: false, follows: false, checked: false, reason: { rule: "stock" } },
		];
		const plan: ModelSetupPlan = {
			assignments: [
				{ role: "default", model: "anthropic/haiku", reason: "Cheaper." },
				{ role: "smol", model: "openrouter/deepseek", reason: "Not in the pool." },
				{ role: "image", model: "anthropic/opus", reason: "Kind roles keep stock's chain." },
			],
			advisor: { enable: true, reason: "" },
			sources: [],
		};
		const out = withResearch(
			rows,
			plan,
			new Set(["anthropic/opus", "anthropic/haiku"]),
			planRoleInputs([role("default"), role("smol"), role("image", { section: "kind" })]),
		);
		expect(out[0]).toMatchObject({ model: "anthropic/haiku", checked: true, research: "Cheaper." });
		expect(out[1]).toEqual(rows[1]);
		expect(out[2]).toEqual(rows[2]);
	});

	it("names the model the advisor runs on, falling back to the Thinking role", () => {
		const roles = [role("slow", { model: "anthropic/opus" }), role("advisor")];
		expect(effectiveAdvisorModel(roles)).toEqual({ model: "anthropic/opus", via: "slow" });
		expect(effectiveAdvisorModel([role("advisor", { model: "openai/gpt-5.2" }), ...roles])).toEqual({
			model: "openai/gpt-5.2",
			via: "advisor",
		});
		expect(effectiveAdvisorModel([role("default")])).toBeUndefined();
	});

	it("reads the facts contract and refuses another shape", () => {
		expect(parseSetupFacts(FACTS)).toEqual(FACTS);
		expect(parseSetupFacts({ providers: {} })).toBeUndefined();
		expect(parseSetupFacts(null)).toBeUndefined();
	});
});

describe("apply record", () => {
	const current = [
		role("default", { model: "a/new:high" }),
		role("smol", { model: "a/cheap" }),
		role("slow", { model: "a/hand" }),
	];

	it("restores only the roles that still hold what the setup wrote, and names the rest", () => {
		const applied: AppliedSetup = {
			at: 1,
			values: { default: "a/new", smol: "a/cheap", slow: "a/strong", gone: "a/x" },
			before: { default: "a/old:low", smol: null, slow: "a/prev", gone: "a/y" },
		};
		expect(undoSteps(applied, current)).toEqual({
			// default holds a/new under a thinking suffix: still the setup's.
			restore: [
				{ role: "default", model: "a/old:low" },
				{ role: "smol", model: null },
			],
			skipped: ["slow", "gone"],
		});
	});

	it("keeps an earlier apply's untouched roles with their original before, drops hand-changed ones", () => {
		const previous: AppliedSetup = {
			at: 1,
			values: { default: "a/new", smol: "a/cheap", slow: "a/strong" },
			before: { default: "a/old", smol: null, slow: "a/prev" },
		};
		const merged = mergeApplied(
			previous,
			current,
			[
				{ role: "smol", model: "a/cheaper" },
				{ role: "task", model: "a/t" },
			],
			2,
		);
		// slow was changed by hand since: gone. smol is rewritten but still the setup's: its original before stays.
		expect(merged).toEqual({
			at: 2,
			values: { default: "a/new", smol: "a/cheaper", task: "a/t" },
			before: { default: "a/old", smol: null, task: null },
		});
		expect(mergeApplied(undefined, current, [{ role: "slow", model: "a/s2" }], 3)).toEqual({
			at: 3,
			values: { slow: "a/s2" },
			before: { slow: "a/hand" },
		});
	});

	it("offers a new setup only when a record's signature differs from now", () => {
		expect(offersNewSetup(undefined, "x")).toBe(false);
		expect(offersNewSetup({ applied: { at: 1, values: {}, before: {} } }, "x")).toBe(false);
		expect(offersNewSetup({ signature: "x" }, "x")).toBe(false);
		expect(offersNewSetup({ signature: "x" }, "y")).toBe(true);
	});
});

describe("apply record in prefs", () => {
	afterEach(() => {
		Reflect.deleteProperty(globalThis, "window");
	});

	function prefs(initial: unknown) {
		let stored = initial;
		const set = vi.fn(async (_key: string, value: unknown) => {
			stored = value;
		});
		Object.assign(globalThis, {
			window: {
				omp: {
					prefs: { get: vi.fn(async (key: string) => (key === MODEL_SETUP_PREFS_KEY ? stored : undefined)), set },
				},
			},
		});
		return { set, stored: () => stored };
	}

	it("reads an old proposal record, or anything unreadable, as nothing", async () => {
		prefs({
			local: {
				savedAt: 1,
				researchModel: "a/b",
				models: [],
				plan: { assignments: [], advisor: { enable: false, reason: "" }, sources: [] },
				dropped: [],
			},
			remote: "nonsense",
		});
		expect(await loadSetupRecord(undefined)).toBeUndefined();
		expect(await loadSetupRecord("remote")).toBeUndefined();
	});

	it("keeps each machine's record apart and removes one on undefined", async () => {
		const { set, stored } = prefs({ "device-1": { signature: "s1" } });
		const applied: AppliedSetup = { at: 5, values: { default: "a/b" }, before: { default: null } };
		await saveSetupRecord(undefined, { applied, signature: "s0" });
		expect(stored()).toEqual({ "device-1": { signature: "s1" }, local: { applied, signature: "s0" } });
		expect(await loadSetupRecord(undefined)).toEqual({ applied, signature: "s0" });
		await saveSetupRecord("device-1", undefined);
		expect(stored()).toEqual({ local: { applied, signature: "s0" } });
		expect(set).toHaveBeenCalledTimes(2);
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
