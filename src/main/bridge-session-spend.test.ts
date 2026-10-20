import { describe, expect, it } from "vitest";
import { spendByProvider } from "../../resources/gui-bridge/session-spend-core";

const DAY = Date.parse("2026-10-20T00:00:00Z");

/** A judge call as stock journals it (`journalJudgmentUsage`): copied from a real session's ledger, 19 Oct 2026. */
const JEV_ROW = {
	type: "model_usage",
	id: "9bb525d3",
	parentId: "6b0f9791",
	timestamp: "2026-10-19T07:05:18.757Z",
	runtime: { version: "18.12.2" },
	purpose: "auto-thinking",
	role: "typesafe",
	api: "openrouter-decisions",
	provider: "openrouter",
	model: "typesafe/jev-1.14",
	usage: {
		input: 581,
		output: 53,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 634,
		cost: { input: 0.000024402, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000024402 },
	},
	stopReason: "stop",
};

const usage = (total: number) => ({ cost: { total } });

describe("spendByProvider", () => {
	it("splits the whole journal by provider: replies, judge calls and subagents' results, and what fell today", () => {
		const entries = [
			JEV_ROW,
			{ ...JEV_ROW, id: "b", timestamp: "2026-10-20T08:00:00.000Z" },
			{
				type: "message",
				timestamp: "2026-10-20T09:00:00.000Z",
				message: { role: "assistant", provider: "anthropic", usage: usage(1.5) },
			},
			{
				type: "message",
				timestamp: "2026-10-19T09:00:00.000Z",
				message: { role: "assistant", provider: "openrouter", usage: usage(0.25) },
			},
			{
				type: "message",
				timestamp: "2026-10-20T10:00:00.000Z",
				message: {
					role: "toolResult",
					toolName: "task",
					details: {
						usage: usage(0.7),
						results: [
							{ resolvedModel: "openai-codex/gpt-6:high", usage: usage(0.4) },
							{ resolvedModel: "openrouter/qwen/qwen-4", usage: usage(0.3) },
						],
					},
				},
			},
			// No cost to count: a user prompt, a reply stock could not price, a session header.
			{ type: "message", timestamp: "2026-10-20T10:00:00.000Z", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", provider: "anthropic", usage: usage(Number.NaN) } },
			{ type: "session", id: "s" },
		];
		const spend = spendByProvider(entries, DAY);
		expect(Object.keys(spend).sort()).toEqual(["anthropic", "openai-codex", "openrouter"]);
		expect(spend.openrouter?.cost).toBeCloseTo(0.000024402 * 2 + 0.25 + 0.3, 12);
		expect(spend.openrouter?.today).toBeCloseTo(0.000024402 + 0.3, 12);
		expect(spend.anthropic).toEqual({ cost: 1.5, today: 1.5 });
		expect(spend["openai-codex"]).toEqual({ cost: 0.4, today: 0.4 });
	});

	it("leaves out a provider that cost nothing", () => {
		const free = {
			...JEV_ROW,
			provider: "ollama",
			usage: { ...JEV_ROW.usage, cost: { ...JEV_ROW.usage.cost, total: 0 } },
		};
		expect(spendByProvider([free], DAY)).toEqual({});
	});
});
