import { describe, expect, it } from "vitest";
import type { CustomProviderView } from "../../../../shared/ipc-types";
import type { ModelInfo, ProviderInfo } from "../../../../shared/rpc-types";
import {
	canServe,
	groupProviders,
	hasUsableModelProvider,
	pickDefaultModel,
	providerDiscoveryErrors,
	RECOMMENDED_PROVIDER_IDS,
	servingProviderIds,
	toProviderInfo,
} from "./provider-catalog";

function provider(partial: Partial<ProviderInfo> & { id: string }): ProviderInfo {
	return {
		name: partial.id,
		authenticated: false,
		loginAvailable: true,
		disabled: false,
		modelCount: 0,
		...partial,
	};
}
function config(partial: Partial<CustomProviderView> & { id: string }): CustomProviderView {
	return {
		api: "openai-completions",
		baseUrl: "https://api.example.com/v1",
		hasApiKey: false,
		models: [{ id: "model-id" }],
		builtin: false,
		...partial,
	};
}

function model(provider: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
	return { provider, id, ...extra };
}

// The machine in the audit: a models.yml provider with a key, plus Apple's
// keyless on-device model that omp discovers on Apple Silicon.
const acme = provider({ id: "acme", authenticated: true, loginAvailable: false, modelCount: 2 });
const apple = provider({
	id: "apple",
	loginAvailable: false,
	modelCount: 1,
	baseUrl: "local://apple-foundation-models",
});
const onDevice = model("apple", "on-device", { name: "On-device", contextWindow: 8_192 });
const opus = model("acme", "acme-opus-5", { name: "Acme Opus 5" });
const flash = model("acme", "acme-flash", { name: "Acme Flash", contextWindow: 128_000 });

describe("hasUsableModelProvider", () => {
	it("requires an enabled provider with both credentials and a model", () => {
		expect(hasUsableModelProvider([], [])).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 0 })], [])).toBe(false);
		expect(
			hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 1, disabled: true })], []),
		).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 1 })], [])).toBe(true);
	});

	it("requires inventory-confirmed models for custom API-key and no-auth providers", () => {
		const gateway = config({ id: "gateway", hasApiKey: true });
		const local = config({ id: "ollama-local", auth: "none" });
		expect(hasUsableModelProvider([], [gateway])).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "gateway", authenticated: true, modelCount: 1 })], [gateway])).toBe(
			true,
		);
		expect(hasUsableModelProvider([provider({ id: "ollama-local", modelCount: 1 })], [local])).toBe(true);
		expect(hasUsableModelProvider([provider({ id: "ollama-local", modelCount: 0 })], [local])).toBe(false);
	});

	it("does not count a keyless discovered provider as a setup", () => {
		expect(hasUsableModelProvider([apple], [])).toBe(false);
		expect([...servingProviderIds([acme, apple], [])]).toEqual(["acme"]);
	});
});

describe("pickDefaultModel", () => {
	it("never picks the on-device model while a connected provider can serve", () => {
		const serving = servingProviderIds([acme, apple], []);
		expect(pickDefaultModel([onDevice, opus, flash], serving)?.id).toBe("acme-opus-5");
		expect(canServe(onDevice, serving)).toBe(false);
	});

	it("rejects windows too small for a coding session even on a connected provider", () => {
		const serving = new Set(["acme"]);
		const tiny = model("acme", "tiny", { contextWindow: 8_000, isRecommended: true });
		expect(pickDefaultModel([tiny, flash], serving)?.id).toBe("acme-flash");
		expect(pickDefaultModel([tiny], serving)).toBeUndefined();
	});

	it("prefers the provider just connected, then omp's recommendation, then the catalog score", () => {
		const serving = new Set(["acme", "other"]);
		const strong = model("other", "strong", { int: 90 });
		const recommended = model("other", "pick-me", { isRecommended: true, int: 10 });
		expect(pickDefaultModel([opus, strong, recommended], serving)?.id).toBe("pick-me");
		expect(pickDefaultModel([opus, strong, recommended], serving, "acme")?.id).toBe("acme-opus-5");
		expect(pickDefaultModel([opus, strong], serving)?.id).toBe("strong");
	});
});

describe("groupProviders", () => {
	const rows = [
		provider({ id: "zed-ai", name: "Zed AI" }),
		provider({ id: "deepseek", name: "DeepSeek" }),
		provider({ id: "anthropic", name: "Anthropic (Claude Pro/Max)" }),
		provider({ id: "acme", name: "acme", authenticated: true }),
		provider({ id: "baseten", name: "Baseten" }),
	];

	it("puts connected first, recommended in their fixed order, and the rest alphabetically", () => {
		const groups = groupProviders(rows);
		expect(groups.connected.map(row => row.id)).toEqual(["acme"]);
		expect(groups.recommended.map(row => row.id)).toEqual(
			RECOMMENDED_PROVIDER_IDS.filter(id => id === "anthropic" || id === "deepseek"),
		);
		expect(groups.others.map(row => row.id)).toEqual(["baseten", "zed-ai"]);
	});

	it("filters every group by name, id or endpoint", () => {
		const groups = groupProviders(rows, "seek");
		expect(groups.recommended.map(row => row.id)).toEqual(["deepseek"]);
		expect(groups.connected).toEqual([]);
		expect(groups.others).toEqual([]);
	});
});

describe("toProviderInfo", () => {
	it("accepts rows from bridges that omit the newer flags", () => {
		expect(
			toProviderInfo({ id: "fixture", name: "Local fixture", authenticated: true, modelCount: 1 }),
		).toMatchObject({
			id: "fixture",
			authenticated: true,
			loginAvailable: false,
			disabled: false,
			modelCount: 1,
		});
		expect(toProviderInfo({ name: "no id" })).toBeNull();
	});
});

describe("providerDiscoveryErrors", () => {
	it("reports required discovery failures only", () => {
		expect(
			providerDiscoveryErrors(
				[
					{ provider: "apple", status: "unavailable", optional: true, stale: false, models: [] },
					{
						provider: "acme",
						status: "unavailable",
						optional: false,
						stale: false,
						models: [],
						error: "ECONNREFUSED",
					},
					{ provider: "ollama", status: "unavailable", optional: false, stale: false, models: [] },
					{ provider: "ok", status: "ok", optional: false, stale: false, models: [] },
				],
				"unavailable",
			),
		).toEqual(["acme: ECONNREFUSED", "ollama: unavailable"]);
	});
});
