import { describe, expect, test } from "vitest";
import { defaultProviderDiscovery, providerRequiresManualModels } from "./ProviderConfigDialog";

describe("custom provider discovery defaults", () => {
	test("keeps /v1/models discovery opt-in for new providers", () => {
		expect(defaultProviderDiscovery()).toBeUndefined();
	});

	test("allows a discovery-only provider without a hand-written model row", () => {
		expect(providerRequiresManualModels("openai-models-list")).toBe(false);
		expect(providerRequiresManualModels(undefined)).toBe(true);
	});
});
