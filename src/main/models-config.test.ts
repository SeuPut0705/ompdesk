import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import type { CustomProviderInput } from "../shared/ipc-types";
import { deleteModelsProvider, listModelsProviders, modelsPath, upsertModelsProvider } from "./models-config";
import { modelsConfigMetadata } from "./models-config-stock";
import { ompPackageRoot, systemOmp } from "./omp-runtime";
import { CustomProviderInputSchema } from "./remote/app-protocol";
import * as stockHelper from "./stock-helper";
import { stopStockHelper } from "./stock-helper";

const stock = await systemOmp();
const available = stock.ok && ompPackageRoot(stock.runtime.bin) !== null;
const minimal: CustomProviderInput = {
	id: "test-provider",
	api: "openai-completions",
	baseUrl: "https://api.test/v1",
	models: [{ id: "model-a" }],
};

describe.skipIf(!available)("models.yml through installed stock", () => {
	let dir: string;
	let original: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "omp-models-stock-"));
		mkdirSync(dir, { recursive: true });
		original = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	afterEach(() => {
		stopStockHelper();
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
		rmSync(dir, { recursive: true, force: true });
	});

	test("derives the full stock roster and option vocabularies", async () => {
		const options = await modelsConfigMetadata();
		expect(options.builtinProviders).toContain("openai-codex-device");
		expect(options.apis).toContain("anthropic-messages");
		expect(options.apis).toContain("typesafe");
		expect(options.auth).toContain("oauth");
		expect(options.discovery).toContain("apple-foundation-models");
		expect(options.thinkingModes).toContain("anthropic-budget-effort");
		expect(options.efforts).toContain("max");
	});

	test("round-trips models and discovery-only providers", async () => {
		await upsertModelsProvider(minimal);
		await upsertModelsProvider({
			...minimal,
			id: "messages",
			api: "anthropic-messages",
			discovery: { type: "openai-models-list" },
			models: [],
		});
		const providers = await listModelsProviders();
		expect(providers.find(provider => provider.id === minimal.id)).toMatchObject({ ...minimal, builtin: false });
		expect(providers.find(provider => provider.id === "messages")).toMatchObject({
			api: "anthropic-messages",
			discovery: { type: "openai-models-list" },
			models: [],
		});
	});

	test("keeps a key unless explicitly cleared and never exposes it in a list", async () => {
		await upsertModelsProvider({ ...minimal, apiKey: "sk-original-secret" });
		await upsertModelsProvider({ ...minimal, baseUrl: "https://api.test/v2" });
		expect(parse(readFileSync(modelsPath(), "utf8")).providers[minimal.id].apiKey).toBe("sk-original-secret");
		const view = (await listModelsProviders())[0];
		expect(view.hasApiKey).toBe(true);
		expect(view).not.toHaveProperty("apiKey");
		await upsertModelsProvider({ ...minimal, clearApiKey: true });
		expect(parse(readFileSync(modelsPath(), "utf8")).providers[minimal.id]).not.toHaveProperty("apiKey");
	});

	test("preserves unrendered provider/model/compat fields and comments", async () => {
		writeFileSync(
			modelsPath(),
			`# Company gateway
providers:
  untouched: # Leave this provider alone
    api: openai-completions
    baseUrl: https://legacy.test/v1
  test-provider:
    api: openai-completions
    baseUrl: https://api.test/v1 # Keep this endpoint comment
    remoteCompaction: {enabled: true, model: compact-model}
    modelOverrides: {model-a: {contextWindow: 128000}}
    compat: {supportsStore: true, extraBody: {seed: 42}}
    models:
      - id: model-a
        compactionModel: compact-model
        thinking: {mode: effort, efforts: [low, high], effortMap: {low: low}, requiresEffort: true}
        cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0}
`,
		);
		const view = (await listModelsProviders()).find(provider => provider.id === minimal.id);
		if (!view) throw new Error("Missing test provider");
		await upsertModelsProvider({
			...minimal,
			baseUrl: "https://api.test/v2",
			extraBody: { temperature: 0.5 },
			models: [{ ...view.models[0], name: "Renamed" }],
		});
		const text = readFileSync(modelsPath(), "utf8");
		const saved = parse(text).providers[minimal.id];
		expect(text).toContain("# Company gateway");
		expect(text).toContain("Leave this provider alone");
		expect(text).toContain("Keep this endpoint comment");
		expect(saved.remoteCompaction).toEqual({ enabled: true, model: "compact-model" });
		expect(saved.modelOverrides).toEqual({ "model-a": { contextWindow: 128000 } });
		expect(saved.compat).toEqual({ supportsStore: true, extraBody: { temperature: 0.5 } });
		expect(saved.models[0]).toMatchObject({
			name: "Renamed",
			compactionModel: "compact-model",
			thinking: { effortMap: { low: "low" }, requiresEffort: true },
		});
	});

	test("normalizes legacy thinking ranges through stock", async () => {
		writeFileSync(
			modelsPath(),
			`providers:
  test-provider:
    api: openai-completions
    baseUrl: https://api.test/v1
    models:
      - id: ranged
        thinking: {mode: effort, minLevel: low, maxLevel: high}
      - id: levelled
        thinking: {mode: budget, levels: [minimal, medium], effortMap: {minimal: low}}
`,
		);
		const view = (await listModelsProviders())[0];
		expect(view.models[0].thinking?.efforts).toEqual(["low", "medium", "high"]);
		expect(view.models[1].thinking?.efforts).toEqual(["minimal", "medium"]);
		await upsertModelsProvider({ ...minimal, models: view.models });
		const models = parse(readFileSync(modelsPath(), "utf8")).providers[minimal.id].models;
		expect(models[0].thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high"] });
		expect(models[1].thinking).toEqual({
			mode: "budget",
			efforts: ["minimal", "medium"],
			effortMap: { minimal: "low" },
		});
	});

	test("refuses invalid stock shapes without modifying the file or exposing secrets", async () => {
		await upsertModelsProvider(minimal);
		const before = readFileSync(modelsPath(), "utf8");
		await expect(
			upsertModelsProvider({ ...minimal, apiKey: "do-not-log", models: [{ id: "", cost: { input: 1 } }] }),
		).rejects.toThrow("ModelsConfigSchema");
		await expect(
			upsertModelsProvider(CustomProviderInputSchema.parse({ ...minimal, api: "not-a-stock-api" })),
		).rejects.toThrow("ModelsConfigSchema");
		expect(readFileSync(modelsPath(), "utf8")).toBe(before);
	});

	test("rejects all catalog built-ins and marks hand-written overrides", async () => {
		for (const id of ["openai", "anthropic", "openai-codex-device", "zai-coding-plan", "gitlab-duo-agent"]) {
			await expect(upsertModelsProvider({ ...minimal, id })).rejects.toThrow("built-in provider");
			await expect(deleteModelsProvider(id)).rejects.toThrow("built-in provider");
		}
		writeFileSync(modelsPath(), "providers:\n  anthropic:\n    baseUrl: https://gateway.test\n");
		expect((await listModelsProviders())[0].builtin).toBe(true);
	});

	test("serializes concurrent provider edits across stock helper awaits", async () => {
		await Promise.all([upsertModelsProvider(minimal), upsertModelsProvider({ ...minimal, id: "second-provider" })]);
		expect((await listModelsProviders()).map(provider => provider.id).sort()).toEqual([
			"second-provider",
			"test-provider",
		]);
	});

	test("writes atomically to the preferred path and removes custom entries", async () => {
		await upsertModelsProvider(minimal);
		expect(readdirSync(dir)).toEqual(["models.yml"]);
		expect(modelsPath()).toBe(join(dir, "models.yml"));
		expect(existsSync(join(dir, "models.yaml"))).toBe(false);
		await deleteModelsProvider(minimal.id);
		expect(await listModelsProviders()).toEqual([]);
	});
});

describe("missing installed-stock roster", () => {
	test("refuses both create and delete without changing models.yml", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-models-no-roster-"));
		const original = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		const file = modelsPath();
		const before = "providers:\n  test-provider:\n    api: openai-completions\n";
		writeFileSync(file, before);
		const request = vi
			.spyOn(stockHelper, "stockHelperRequest")
			.mockRejectedValue(new Error("Cannot determine installed stock catalog roster"));
		try {
			await expect(upsertModelsProvider(minimal)).rejects.toThrow("catalog roster");
			await expect(deleteModelsProvider(minimal.id)).rejects.toThrow("catalog roster");
			expect(readFileSync(file, "utf8")).toBe(before);
		} finally {
			request.mockRestore();
			stopStockHelper();
			if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = original;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
