import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "../../../../shared/rpc-types";
import { FEATURED_PROVIDERS } from "./provider-catalog";
import { buildProviderGroups, providerLabel, providerPlan, shortProviderName } from "./provider-groups";

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

describe("provider names and groups", () => {
	const stock = (id: string, name: string, extra: Partial<ProviderInfo> = {}) =>
		provider({ id, name, authenticated: true, ...extra });

	it("names every featured provider by brand, never by plan", () => {
		for (const { id } of FEATURED_PROVIDERS) expect(shortProviderName({ id, name: "x" })).not.toBe("x");
		expect(shortProviderName({ id: "anthropic", name: "Anthropic (Claude Pro/Max)" })).toBe("Claude");
		expect(shortProviderName({ id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)" })).toBe("ChatGPT");
		expect(shortProviderName({ id: "xai-oauth", name: "xAI Grok OAuth (SuperGrok or X Premium+)" })).toBe("Grok");
		expect(shortProviderName({ id: "google-gemini-cli", name: "Google Cloud Code Assist (Gemini CLI)" })).toBe(
			"Gemini",
		);
	});

	it("falls back to stock's name without its parenthetical", () => {
		expect(shortProviderName({ id: "acme", name: "Acme Cloud (Team plan)" })).toBe("Acme Cloud");
		expect(shortProviderName({ id: "deepseek", name: "DeepSeek" })).toBe("DeepSeek");
	});

	it("reads the plan from stock's live name, so a rename shows without an OMPdesk change", () => {
		expect(providerPlan({ id: "anthropic", name: "Anthropic (Claude Pro/Max)" })).toBe("Pro/Max");
		expect(providerLabel({ id: "anthropic", name: "Anthropic (Claude Ultra)" })).toBe("Claude (Ultra)");
		expect(providerLabel({ id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)" })).toBe(
			"ChatGPT (Plus/Pro)",
		);
		expect(providerLabel({ id: "openrouter", name: "OpenRouter" })).toBe("OpenRouter");
		expect(providerPlan({ id: "deepseek", name: "DeepSeek" })).toBeNull();
	});

	it("builds one group per connected provider, ordered by company, subscriptions with accounts", () => {
		const groups = buildProviderGroups([
			stock("openrouter", "OpenRouter", { authKind: "apikey", loginAvailable: true }),
			stock("openai-codex", "ChatGPT Plus/Pro (Codex Subscription)", { authKind: "oauth", loginAvailable: true }),
			stock("anthropic", "Anthropic (Claude Pro/Max)", { authKind: "oauth", loginAvailable: true }),
			provider({ id: "groq", name: "Groq" }),
		]);
		expect(groups.map(group => group.provider.id)).toEqual(["anthropic", "openai-codex", "openrouter"]);
		expect(groups.map(group => group.shortName)).toEqual(["Claude", "ChatGPT", "OpenRouter"]);
		expect(groups.map(group => group.fullName)).toEqual([
			"Anthropic (Claude Pro/Max)",
			"ChatGPT Plus/Pro (Codex Subscription)",
			"OpenRouter",
		]);
		expect(groups.map(group => group.kind)).toEqual(["accounts", "accounts", "single"]);
	});
});
