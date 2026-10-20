import { describe, expect, it } from "vitest";
import { chipModelName } from "./provider-marks";

const of = (provider: string, name: string) => chipModelName({ id: provider, name: provider }, name);

describe("chipModelName", () => {
	it.each([
		["anthropic", "Claude Opus 5.5", "Opus 5.5"],
		["anthropic", "Claude Sonnet 5.5", "Sonnet 5.5"],
		["anthropic", "Claude Haiku 4.5", "Haiku 4.5"],
		["amazon-bedrock", "Claude Opus 5.5", "Claude Opus 5.5"],
		["openai-codex", "GPT-6.1 Sol", "GPT-6.1 Sol"],
		["openai", "GPT-6.1 Codex", "GPT-6.1 Codex"],
		["google", "Gemini 3 Pro", "Gemini 3 Pro"],
		["google-gemini-cli", "Gemini Flash Lite", "Flash Lite"],
		["xai", "Grok 5", "Grok 5"],
		["xai-oauth", "Grok Code Fast", "Code Fast"],
		["mistral", "Mistral Large 3", "Large 3"],
		["openrouter", "Anthropic: Claude Sonnet 5.5", "Anthropic: Claude Sonnet 5.5"],
		["openrouter", "OpenRouter: Auto Router", "Auto Router"],
		["nanogpt", "Claude Opus 5.5", "Claude Opus 5.5"],
		["unknown-provider", "Claude Opus 5.5", "Claude Opus 5.5"],
		["anthropic", "Claude", "Claude"],
	])("%s · %s → %s", (provider, name, shown) => {
		expect(of(provider, name)).toBe(shown);
	});
});
