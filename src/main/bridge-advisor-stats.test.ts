import { describe, expect, it } from "vitest";
import { type AdvisorStatsLike, advisorUsage } from "../../resources/gui-bridge/advisor-stats-core";

const tokens = { input: 10, output: 4, reasoning: 2, cacheRead: 7, cacheWrite: 1, total: 24 };

function stats(over: Partial<AdvisorStatsLike> = {}): AdvisorStatsLike {
	return {
		configured: true,
		active: true,
		cost: 0.5,
		tokens,
		advisors: [
			{
				name: "default",
				status: "running",
				model: { provider: "openai", id: "gpt-5" },
				messages: { assistant: 3 },
				cost: 0.3,
			},
			{ name: "second", status: "paused", messages: { assistant: 2 }, cost: 0.2 },
		],
		...over,
	};
}

const advisorEntry = (...severities: (string | undefined)[]) => ({
	type: "custom_message",
	customType: "advisor",
	details: { notes: severities.map(severity => ({ note: "n", ...(severity ? { severity } : {}) })) },
});

describe("advisorUsage", () => {
	it("maps stock's stats: flags, session cost, tokens, per-advisor rows and the calls sum", () => {
		const usage = advisorUsage(stats(), true, []);
		expect(usage).toMatchObject({
			configured: true,
			active: true,
			subscription: true,
			cost: 0.5,
			calls: 5,
			tokens: { input: 10, output: 4, cacheRead: 7, total: 24 },
		});
		expect(usage.advisors).toEqual([
			{ name: "default", status: "running", model: "openai/gpt-5", calls: 3, cost: 0.3 },
			{ name: "second", status: "paused", model: undefined, calls: 2, cost: 0.2 },
		]);
	});

	it("counts every note of every advisor entry by severity; unknown or missing severity is `other`", () => {
		const branch = [
			advisorEntry("concern", "concern"),
			advisorEntry("nit", "blocker", undefined, "weird"),
			{ type: "custom_message", customType: "other-thing", details: { notes: [{ severity: "blocker" }] } },
			{ type: "message", customType: "advisor", details: { notes: [{ severity: "blocker" }] } },
		];
		expect(advisorUsage(stats(), false, branch).advisories).toEqual({
			total: 6,
			blocker: 1,
			concern: 2,
			nit: 1,
			other: 2,
		});
	});

	it("skips malformed entries and notes instead of throwing", () => {
		const branch = [
			null,
			"text",
			42,
			{ type: "custom_message", customType: "advisor" },
			{ type: "custom_message", customType: "advisor", details: null },
			{ type: "custom_message", customType: "advisor", details: { notes: "nope" } },
			{ type: "custom_message", customType: "advisor", details: { notes: [null, 3, { severity: "nit" }] } },
		];
		expect(advisorUsage(stats(), false, branch).advisories).toEqual({
			total: 1,
			blocker: 0,
			concern: 0,
			nit: 1,
			other: 0,
		});
	});

	it("turns non-finite numbers into 0 and an idle roster into zeros", () => {
		const usage = advisorUsage(
			stats({
				cost: Number.NaN,
				tokens: { ...tokens, input: Number.POSITIVE_INFINITY, cacheRead: Number.NaN },
				advisors: [{ name: "a", status: "error", messages: { assistant: Number.NaN }, cost: Number.NaN }],
			}),
			false,
			[],
		);
		expect(usage.cost).toBe(0);
		expect(usage.tokens).toEqual({ input: 0, output: 4, cacheRead: 0, total: 24 });
		expect(usage.calls).toBe(0);
		expect(usage.advisors).toEqual([{ name: "a", status: "error", model: undefined, calls: 0, cost: 0 }]);
		expect(usage.advisories).toEqual({ total: 0, blocker: 0, concern: 0, nit: 0, other: 0 });
	});
});
