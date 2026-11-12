import { describe, expect, it } from "vitest";
import {
	isCreditProvider,
	overageCoversAccount,
	overageUntil,
	type PlanLimitLike,
	planSpentError,
	planSpentUntil,
	setCreditSpend,
	UNTIMED_SPENT_MS,
	withoutCredits,
} from "../../resources/gui-bridge/credit-spend-core";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const limit = (
	id: string,
	usedFraction: number,
	resetsIn: number,
	extra: Partial<PlanLimitLike> = {},
): PlanLimitLike => ({
	id,
	scope: { shared: true },
	amount: { usedFraction },
	window: { resetsAt: NOW + resetsIn },
	...extra,
});

describe("planSpentUntil", () => {
	it("reads a ChatGPT plan window at 100 % as spent until its reset, and the latest reset when both are spent", () => {
		expect(planSpentUntil("openai-codex", { limits: [limit("openai-codex:primary", 1, 3 * HOUR)] }, NOW)).toBe(
			NOW + 3 * HOUR,
		);
		const both = [limit("openai-codex:primary", 1, 3 * HOUR), limit("openai-codex:secondary", 1, 90 * HOUR)];
		expect(planSpentUntil("openai-codex", { limits: both }, NOW)).toBe(NOW + 90 * HOUR);
	});

	it("leaves a plan with room, a passed reset and Codex's spend cap or extra meters alone", () => {
		const room = [limit("openai-codex:primary", 0.99, 3 * HOUR), limit("openai-codex:secondary", 0.4, 90 * HOUR)];
		expect(planSpentUntil("openai-codex", { limits: room }, NOW)).toBeUndefined();
		expect(planSpentUntil("openai-codex", { limits: [limit("openai-codex:primary", 1, -1)] }, NOW)).toBeUndefined();
		const notPlan = [limit("openai-codex:spend-cap", 1, HOUR), limit("openai-codex:spark:primary", 1, HOUR)];
		expect(planSpentUntil("openai-codex", { limits: notPlan }, NOW)).toBeUndefined();
		expect(planSpentUntil("openai-codex", null, NOW)).toBeUndefined();
	});

	it("takes stock's exhausted status and used/limit counters, not only the fraction", () => {
		const status = limit("openai-codex:primary", 0.97, HOUR, { status: "exhausted" });
		expect(planSpentUntil("openai-codex", { limits: [status] }, NOW)).toBe(NOW + HOUR);
		const counted: PlanLimitLike = {
			id: "anthropic:5h",
			scope: { shared: true },
			amount: { used: 50, limit: 50 },
			window: { resetsAt: NOW + HOUR },
		};
		expect(planSpentUntil("anthropic", { limits: [counted] }, NOW)).toBe(NOW + HOUR);
	});

	it("reads Codex's plan verdict without credits: limit reached under 100 % is spent until the next reset", () => {
		const report = { limits: [limit("openai-codex:primary", 0.98, 2 * HOUR)], metadata: { limitReached: true } };
		expect(planSpentUntil("openai-codex", report, NOW)).toBe(NOW + 2 * HOUR);
		expect(planSpentUntil("openai-codex", { limits: [], metadata: { limitReached: true } }, NOW)).toBe(
			NOW + UNTIMED_SPENT_MS,
		);
	});

	it("reads Claude's shared windows as its plan, never its extra-usage row or a model's own week", () => {
		const fiveHour = limit("anthropic:5h", 1, 2 * HOUR);
		expect(planSpentUntil("anthropic", { limits: [fiveHour, limit("anthropic:7d", 0.4, 80 * HOUR)] }, NOW)).toBe(
			NOW + 2 * HOUR,
		);
		const extra = limit("anthropic:extra", 1, HOUR, { scope: {} });
		const fable = limit("anthropic:7d:fable", 1, HOUR, { scope: {} });
		expect(planSpentUntil("anthropic", { limits: [extra, fable] }, NOW)).toBeUndefined();
		expect(planSpentUntil("anthropic", { limits: [], metadata: { limitReached: true } }, NOW)).toBeUndefined();
	});
});

describe("overageUntil", () => {
	const seconds = (ms: number) => String((NOW + ms) / 1000);

	it("is the claimed window's reset while Claude serves on extra usage", () => {
		const headers = {
			"anthropic-ratelimit-unified-overage-in-use": "true",
			"anthropic-ratelimit-unified-representative-claim": "seven_day",
			"anthropic-ratelimit-unified-5h-reset": seconds(HOUR),
			"anthropic-ratelimit-unified-7d-reset": seconds(50 * HOUR),
		};
		expect(overageUntil(headers, NOW)).toBe(NOW + 50 * HOUR);
		expect(overageUntil({ ...headers, "anthropic-ratelimit-unified-representative-claim": "five_hour" }, NOW)).toBe(
			NOW + HOUR,
		);
	});

	it("falls back to the unified reset, then stock's default block, and is nothing on the plan", () => {
		const inUse = { "anthropic-ratelimit-unified-overage-in-use": "true" };
		expect(overageUntil({ ...inUse, "anthropic-ratelimit-unified-reset": seconds(2 * HOUR) }, NOW)).toBe(
			NOW + 2 * HOUR,
		);
		expect(overageUntil(inUse, NOW)).toBe(NOW + UNTIMED_SPENT_MS);
		expect(overageUntil({ "anthropic-ratelimit-unified-overage-in-use": "false" }, NOW)).toBeUndefined();
		expect(overageUntil({}, NOW)).toBeUndefined();
	});

	it("covers the whole account only for a window all its models share", () => {
		const claim = (name: string) => ({ "anthropic-ratelimit-unified-representative-claim": name });
		expect(overageCoversAccount(claim("five_hour"))).toBe(true);
		expect(overageCoversAccount(claim("seven_day"))).toBe(true);
		// A model's own weekly window, or a claim this build has not heard of, leaves the account's other models alone.
		expect(overageCoversAccount(claim("seven_day_opus"))).toBe(false);
		expect(overageCoversAccount(claim("seven_day_sonnet"))).toBe(false);
		expect(overageCoversAccount(claim("something_new"))).toBe(false);
		expect(overageCoversAccount({})).toBe(false);
		// Its reset is still the weekly one.
		expect(
			overageUntil(
				{
					"anthropic-ratelimit-unified-overage-in-use": "true",
					...claim("seven_day_opus"),
					"anthropic-ratelimit-unified-7d-reset": seconds(50 * HOUR),
				},
				NOW,
			),
		).toBe(NOW + 50 * HOUR);
	});
});

describe("withoutCredits", () => {
	it("drops only the credits block of a Codex usage answer", () => {
		const answer = {
			rate_limit: { limit_reached: true },
			credits: { has_credits: true, balance: "500" },
			plan_type: "plus",
		};
		expect(withoutCredits(answer)).toEqual({ rate_limit: { limit_reached: true }, plan_type: "plus" });
		expect(answer.credits).toEqual({ has_credits: true, balance: "500" });
		for (const other of [null, "text", [1], { rate_limit: {} }]) expect(withoutCredits(other)).toEqual(other);
	});
});

describe("the switch and the refusal", () => {
	it("accepts exactly {enabled: boolean}", () => {
		for (const bad of [null, {}, { enabled: "true" }, { enabled: 1 }]) {
			expect(() => setCreditSpend(bad)).toThrow(/credit_spend_set/);
		}
		expect(setCreditSpend({ enabled: true })).toEqual({ enabled: true });
		expect(setCreditSpend({ enabled: false })).toEqual({ enabled: false });
	});

	it("covers ChatGPT and Claude only", () => {
		expect(["openai-codex", "anthropic", "openai", "google-gemini-cli"].map(isCreditProvider)).toEqual([
			true,
			true,
			false,
			false,
		]);
	});

	it("words the refusal as a usage limit, with the provider and the wait", () => {
		const message = planSpentError("openai-codex", NOW + 3 * HOUR, NOW);
		expect(message).toMatch(/^usage_limit_reached: /);
		expect(message).toContain("ChatGPT");
		expect(message).toContain("about 3 hours");
		expect(planSpentError("anthropic", NOW + 20 * 60_000, NOW)).toContain("about 20 minutes");
	});
});
