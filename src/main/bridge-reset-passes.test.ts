import { describe, expect, it, vi } from "vitest";
import {
	type LimitState,
	type ResetAccountStatus,
	type ResetCreditsInfo,
	type ResetPassSurface,
	type ResetSummary,
	redeemResetPass,
	shapeResetPasses,
} from "../../resources/gui-bridge/reset-passes-core";

/** Stock `summarizeUsageResetCredits` (pi-tui overlays/usage-display), the parts these cases reach. */
function summarize(reset: ResetCreditsInfo | undefined): ResetSummary | undefined {
	if (!reset) return undefined;
	const expiries = (reset.credits ?? [])
		.filter(credit => credit.expiresAt && credit.status !== "redeemed" && credit.remainingCount !== 0)
		.map(credit => credit.expiresAt ?? "")
		.sort();
	const bankedCount = reset.availableCount;
	const redeemableCount = reset.redeemableCount ?? reset.availableCount;
	return {
		bankedCount,
		redeemableCount,
		soonestExpiry: expiries[0],
		unavailableReason:
			reset.reason ?? (bankedCount > 0 && redeemableCount === 0 ? "not usable right now" : undefined),
	};
}

// Shaped like the reports omp 18.8.0 returns for real accounts (identities dropped).
const codexCredits: ResetCreditsInfo = {
	availableCount: 2,
	credits: [
		{ expiresAt: "2026-11-06T23:32:06.531907Z", status: "available" },
		{ expiresAt: "2026-10-29T19:04:55.251844Z", status: "available" },
	],
};
const codexLimits = (used: number): LimitState[] => [
	{ id: "openai-codex:primary", usedFraction: used, status: used >= 1 ? "exhausted" : "ok" },
	{ id: "openai-codex:secondary", usedFraction: 0.2, status: used >= 1 ? "exhausted" : "ok" },
];
const cedar: ResetCreditsInfo = {
	availableCount: 1,
	redeemableCount: 1,
	eligible: true,
	nextCreditId: "grant_1",
	credits: [
		{
			id: "grant_1",
			title: "One usage-limit reset",
			program: "cedar_ember",
			remainingCount: 1,
			usable: true,
			requiresLimit: false,
			clears: ["anthropic:5h", "anthropic:7d", "anthropic:reset:seven_day_overage_included"],
			expiresAt: "2026-10-22T00:00:00Z",
			status: "available",
		},
	],
};
const claudeLimits: LimitState[] = [
	{ id: "anthropic:5h", usedFraction: 0.61, status: "ok" },
	{ id: "anthropic:7d", usedFraction: 0.08, status: "ok" },
];

describe("shapeResetPasses", () => {
	it("counts Codex passes with the soonest expiry and waits for a reached chat window", () => {
		const passes = shapeResetPasses("openai-codex", codexCredits, summarize(codexCredits), codexLimits(0.4));
		expect(passes).toEqual({
			count: 2,
			usableCount: 2,
			expiresAt: Date.parse("2026-10-29T19:04:55.251844Z"),
			clears: ["openai-codex:primary", "openai-codex:secondary"],
			early: false,
			redeemable: false,
		});
		expect(shapeResetPasses("openai-codex", codexCredits, summarize(codexCredits), codexLimits(1))?.redeemable).toBe(
			true,
		);
	});

	it("takes a Claude grant's coverage, early use and pin from the provider", () => {
		expect(shapeResetPasses("anthropic", cedar, summarize(cedar), claudeLimits)).toEqual({
			count: 1,
			usableCount: 1,
			expiresAt: Date.parse("2026-10-22T00:00:00Z"),
			title: "One usage-limit reset",
			clears: ["anthropic:5h", "anthropic:7d", "anthropic:reset:seven_day_overage_included"],
			early: true,
			creditId: "grant_1",
			redeemable: true,
		});
	});

	it("never spends a Claude grant the listing did not pin", () => {
		const unpinned = { ...cedar, nextCreditId: undefined };
		const passes = shapeResetPasses("anthropic", unpinned, summarize(unpinned), claudeLimits);
		expect(passes).toMatchObject({
			usableCount: 0,
			redeemable: false,
			unavailableReason: "the provider did not identify a grant that can be safely spent",
		});
	});

	it("keeps the provider's reason when nothing is usable now", () => {
		const cooling = { ...cedar, redeemableCount: 0, reason: "cooldown until 2026-10-10" };
		expect(shapeResetPasses("anthropic", cooling, summarize(cooling), claudeLimits)).toMatchObject({
			count: 1,
			usableCount: 0,
			redeemable: false,
			unavailableReason: "cooldown until 2026-10-10",
		});
	});

	it("reports nothing for an account without banked passes", () => {
		const none = { availableCount: 0, redeemableCount: 0 };
		expect(shapeResetPasses("anthropic", none, summarize(none), claudeLimits)).toBeUndefined();
		expect(shapeResetPasses("openai-codex", undefined, undefined, [])).toBeUndefined();
	});
});

describe("redeemResetPass", () => {
	const codexStatus: ResetAccountStatus = {
		...codexCredits,
		provider: "openai-codex",
		credentialId: 4,
		credits: [{ id: "RateLimitResetCredit_a", expiresAt: "2026-10-29T19:04:55Z", status: "available" }],
	};
	const claudeStatus: ResetAccountStatus = {
		...cedar,
		provider: "anthropic",
		credentialId: 7,
		report: { limits: claudeLimits },
	};

	function surface(statuses: ResetAccountStatus[], limits: LimitState[] = []) {
		const redeem = vi.fn(async () => ({ ok: true, code: "reset", cleared: ["anthropic:5h"] }));
		const fake: ResetPassSurface = {
			list: vi.fn(async (provider: string) => statuses.filter(status => status.provider === provider)),
			accounts: list =>
				list.map(status => ({
					label: `account ${status.credentialId}`,
					target: {
						provider: status.provider,
						credentialId: status.credentialId,
						...(status.nextCreditId ? { creditId: status.nextCreditId } : {}),
					},
				})),
			summarize,
			limits: vi.fn(async () => limits),
			redeem,
			describe: (outcome, label) => `${label}: ${outcome.code}`,
		};
		return { fake, redeem };
	}

	it("spends through stock's redeem with stock's target and returns its outcome", async () => {
		const { fake, redeem } = surface([claudeStatus]);
		const result = await redeemResetPass(fake, { provider: "anthropic", credentialId: 7, creditId: "grant_1" });
		expect(redeem).toHaveBeenCalledWith({ provider: "anthropic", credentialId: 7, creditId: "grant_1" });
		expect(result).toEqual({ ok: true, code: "reset", message: "account 7: reset", cleared: ["anthropic:5h"] });
		expect(fake.limits).not.toHaveBeenCalled();
	});

	it("refuses a Codex spend while no chat window is reached, from the cached report", async () => {
		const { fake, redeem } = surface([codexStatus], codexLimits(0.5));
		const result = await redeemResetPass(fake, { provider: "openai-codex", credentialId: 4 });
		expect(result).toMatchObject({ ok: false, code: "not_limited" });
		expect(fake.limits).toHaveBeenCalledWith("openai-codex", 4);
		expect(redeem).not.toHaveBeenCalled();
	});

	it("spends a Codex pass once a chat window is reached", async () => {
		const { fake, redeem } = surface([codexStatus], codexLimits(1));
		await redeemResetPass(fake, { provider: "openai-codex", credentialId: 4 });
		expect(redeem).toHaveBeenCalledWith({ provider: "openai-codex", credentialId: 4 });
	});

	it("refuses unspent when the provider's pick changed since the user confirmed", async () => {
		const { fake, redeem } = surface([claudeStatus]);
		const result = await redeemResetPass(fake, { provider: "anthropic", credentialId: 7, creditId: "grant_0" });
		expect(result).toMatchObject({ ok: false, code: "offer_changed" });
		expect(redeem).not.toHaveBeenCalled();
	});

	it("refuses what stock refuses: no usable pass, a failed listing, an unknown account or provider", async () => {
		const blocked = { ...claudeStatus, redeemableCount: 0, reason: "cooldown" };
		const failed = {
			...claudeStatus,
			credentialId: 8,
			availableCount: 0,
			credits: [],
			error: "token refresh failed",
		};
		const { fake, redeem } = surface([blocked, failed]);
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 7 })).toMatchObject({
			ok: false,
			code: "not_redeemable",
			reason: "cooldown",
		});
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 8 })).toMatchObject({
			ok: false,
			code: "credit_list_failed",
			reason: "token refresh failed",
		});
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 99 })).toMatchObject({
			ok: false,
			code: "no_account",
		});
		expect(await redeemResetPass(fake, { provider: "github-copilot", credentialId: 7 })).toMatchObject({
			ok: false,
			code: "unsupported_provider",
		});
		expect(redeem).not.toHaveBeenCalled();
	});

	it("passes stock's refusal through without claiming success", async () => {
		const { fake, redeem } = surface([claudeStatus]);
		redeem.mockResolvedValueOnce({ ok: false, code: "nothing_to_reset", cleared: [] });
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 7 })).toEqual({
			ok: false,
			code: "nothing_to_reset",
			message: "account 7: nothing_to_reset",
		});
	});
});
