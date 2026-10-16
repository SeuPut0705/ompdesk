import { describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "../../shared/rpc-types";
import { modelSelector, usageByModel } from "./model-usage";

function subagent(id: string, resolvedModel: string | undefined, tokens: number, cost = 0): SubagentSnapshot {
	return {
		id,
		index: 0,
		agent: "task",
		status: "completed",
		lastUpdate: 0,
		progress: {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			task: "t",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 2,
			tokens,
			cost,
			durationMs: 0,
			resolvedModel,
		},
	};
}

describe("model usage", () => {
	it("names a catalog model by provider and id", () => {
		expect(modelSelector({ provider: "openai", id: "gpt-5.2" })).toBe("openai/gpt-5.2");
	});

	it("splits tokens by model, largest first, ignoring subagents with no model yet", () => {
		const rows = usageByModel({ model: "openai/gpt-5.2", requests: 3, tokens: 1000, cost: 0.5 }, [
			subagent("a", "anthropic/claude-haiku-4-5", 2000, 0.1),
			subagent("b", "anthropic/claude-haiku-4-5", 1000, 0.05),
			subagent("c", "openai/gpt-5.2:high", 1000, 0.3),
			subagent("d", undefined, 999),
		]);
		expect(rows.map(row => [row.model, row.main, row.agents, row.tokens])).toEqual([
			["anthropic/claude-haiku-4-5", false, 2, 3000],
			["openai/gpt-5.2", true, 0, 1000],
			["openai/gpt-5.2:high", false, 1, 1000],
		]);
		expect(rows[0].share).toBeCloseTo(0.6);
		expect(rows[0].cost).toBeCloseTo(0.15);
		expect(rows[0].requests).toBe(4);
		expect(usageByModel(null, [])).toEqual([]);
	});
});
