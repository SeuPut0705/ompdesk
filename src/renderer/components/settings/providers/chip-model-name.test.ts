import { describe, expect, it } from "vitest";
import { chipModelName, compactModelLabels, type ModelRef } from "./provider-marks";

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

describe("compactModelLabels", () => {
	const labels = (models: ModelRef[]) => Object.fromEntries(compactModelLabels(models));

	it("drops the brand word and adds no suffix while every name reads differently", () => {
		expect(
			labels([
				{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
				{ provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5" },
				{ provider: "anthropic", id: "claude-fable-5-1", name: "Claude Fable 5.1" },
				{ provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro" },
				{ provider: "openai", id: "gpt-6.1", name: "GPT-6.1" },
				{ provider: "fixture", id: "local-fixture" },
			]),
		).toEqual({
			"anthropic/claude-opus-5-5": { name: "Opus 5.5" },
			"anthropic/claude-fable-5": { name: "Fable 5" },
			"anthropic/claude-fable-5-1": { name: "Fable 5.1" },
			"google/gemini-3-pro": { name: "Gemini 3 Pro" },
			"openai/gpt-6.1": { name: "GPT-6.1" },
			"fixture/local-fixture": { name: "local-fixture" },
		});
	});

	it("tells a dated id from its alias by the date, and a version step by its digit", () => {
		expect(
			labels([
				{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
				{ provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
				{ provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5" },
				{ provider: "anthropic", id: "claude-fable-5-1", name: "Claude Fable 5" },
			]),
		).toEqual({
			"anthropic/claude-haiku-4-5": { name: "Haiku 4.5" },
			"anthropic/claude-haiku-4-5-20251001": { name: "Haiku 4.5", suffix: "20251001" },
			"anthropic/claude-fable-5": { name: "Fable 5" },
			"anthropic/claude-fable-5-1": { name: "Fable 5", suffix: "1" },
		});
	});

	it("cuts ids at whole tokens, so a shared leading digit stays in the suffix", () => {
		expect(
			labels([
				{ provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
				{ provider: "google", id: "gemini-3-pro-preview-06", name: "Gemini 3 Pro" },
				{ provider: "google", id: "gemini-3-pro-preview-0605", name: "Gemini 3 Pro" },
			]),
		).toEqual({
			"google/gemini-3-pro-preview": { name: "Gemini 3 Pro" },
			"google/gemini-3-pro-preview-06": { name: "Gemini 3 Pro", suffix: "06" },
			"google/gemini-3-pro-preview-0605": { name: "Gemini 3 Pro", suffix: "0605" },
		});
	});

	it("names the provider when one id sits under two providers drawn with the same mark", () => {
		expect(
			labels([
				{ provider: "openai", id: "gpt-6.1", name: "GPT-6.1" },
				{ provider: "openai-codex", id: "gpt-6.1", name: "GPT-6.1" },
				{ provider: "openai", id: "gpt-6.1-2026-01-15", name: "GPT-6.1" },
			]),
		).toEqual({
			"openai/gpt-6.1": { name: "GPT-6.1", suffix: "openai" },
			"openai-codex/gpt-6.1": { name: "GPT-6.1", suffix: "openai-codex" },
			"openai/gpt-6.1-2026-01-15": { name: "GPT-6.1", suffix: "2026-01-15" },
		});
	});

	it("leaves rows alone whose marks already differ, and lists a repeated model once", () => {
		expect(
			labels([
				{ provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro" },
				{ provider: "google-vertex", id: "gemini-3-pro", name: "Gemini 3 Pro" },
				{ provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro" },
			]),
		).toEqual({
			"google/gemini-3-pro": { name: "Gemini 3 Pro" },
			"google-vertex/gemini-3-pro": { name: "Gemini 3 Pro" },
		});
	});

	it("tells apart two unknown providers whose fallback glyphs draw the same letter", () => {
		expect(
			labels([
				{ provider: "acme-east", id: "chat-1", name: "Chat 1" },
				{ provider: "acme-west", id: "chat-1", name: "Chat 1" },
				{ provider: "bolt", id: "chat-1", name: "Chat 1" },
			]),
		).toEqual({
			"acme-east/chat-1": { name: "Chat 1", suffix: "acme-east" },
			"acme-west/chat-1": { name: "Chat 1", suffix: "acme-west" },
			"bolt/chat-1": { name: "Chat 1" },
		});
	});
});
