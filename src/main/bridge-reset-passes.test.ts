import { describe, expect, it, vi } from "vitest";
import {
	type ResetAccountStatus,
	type ResetPassSurface,
	type ResetUsageAccount,
	redeemResetPass,
	shapeResetPasses,
} from "../../resources/gui-bridge/reset-passes-core";

const account: ResetUsageAccount = {
	label: "account 7",
	target: { provider: "anthropic", credentialId: 7, creditId: "grant_1" },
	availableCount: 2,
	redeemableCount: 1,
	expiresAt: "2026-10-22T00:00:00Z",
	credit: { id: "grant_1", title: "Reset", requiresLimit: false, clears: ["anthropic:5h"] },
};
const status: ResetAccountStatus = {
	provider: "anthropic",
	credentialId: 7,
	availableCount: 2,
	credits: [],
	active: true,
};
function surface(selected: ResetUsageAccount = account, statuses: ResetAccountStatus[] = [status]) {
	const redeem = vi.fn(async () => ({ ok: true, code: "reset", cleared: ["anthropic:5h"] }));
	const fake: ResetPassSurface = {
		list: vi.fn(async provider => statuses.filter(candidate => candidate.provider === provider)),
		accounts: () => [selected],
		redeem,
		describe: (outcome, label) => `${label}: ${outcome.code}`,
	};
	return { fake, redeem };
}
describe("stock reset selector wire projection", () => {
	it("projects stock-selected counts, credit, expiry and coverage unchanged", () => {
		expect(shapeResetPasses(account)).toEqual({
			count: 2,
			usableCount: 1,
			expiresAt: Date.parse(account.expiresAt ?? ""),
			title: "Reset",
			clears: ["anthropic:5h"],
			early: true,
			creditId: "grant_1",
			redeemable: true,
		});
	});
	it("offers manual Codex redemption without imposing the automatic exhausted-window policy", () => {
		expect(
			shapeResetPasses({ ...account, target: { provider: "openai-codex", credentialId: 7 }, credit: undefined }),
		).toMatchObject({ redeemable: true, clears: [] });
	});
	it("preserves stock refusal and hides empty listings", () => {
		expect(shapeResetPasses({ ...account, redeemableCount: 0, unavailableReason: "cooldown" })).toMatchObject({
			redeemable: false,
			usableCount: 0,
			unavailableReason: "cooldown",
		});
		expect(shapeResetPasses({ ...account, availableCount: 0 })).toBeUndefined();
		expect(shapeResetPasses(undefined)).toBeUndefined();
	});
});
describe("reset confirmation binding", () => {
	it("passes the stock target and outcome through", async () => {
		const { fake, redeem } = surface();
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 7, creditId: "grant_1" })).toEqual({
			ok: true,
			code: "reset",
			message: "account 7: reset",
			cleared: ["anthropic:5h"],
		});
		expect(redeem).toHaveBeenCalledWith(account.target);
	});
	it("does not spend a changed confirmed offer", async () => {
		const { fake, redeem } = surface();
		expect(
			await redeemResetPass(fake, { provider: "anthropic", credentialId: 7, creditId: "old-grant" }),
		).toMatchObject({ ok: false, code: "offer_changed" });
		expect(redeem).not.toHaveBeenCalled();
	});
	it("refuses stock ineligibility, listing failures, absent accounts and unsupported providers", async () => {
		const { fake, redeem } = surface({ ...account, redeemableCount: 0, unavailableReason: "cooldown" });
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 7 })).toMatchObject({
			ok: false,
			code: "not_redeemable",
			reason: "cooldown",
		});
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 99 })).toMatchObject({
			code: "no_account",
		});
		expect(await redeemResetPass(fake, { provider: "github-copilot", credentialId: 7 })).toMatchObject({
			code: "no_account",
		});
		const failed = surface(account, [{ ...status, error: "listing failed" }]);
		expect(await redeemResetPass(failed.fake, { provider: "anthropic", credentialId: 7 })).toMatchObject({
			code: "credit_list_failed",
		});
		expect(redeem).not.toHaveBeenCalled();
		expect(failed.redeem).not.toHaveBeenCalled();
	});
	it("lets stock decide nothing-to-reset without claiming success", async () => {
		const { fake, redeem } = surface();
		redeem.mockResolvedValueOnce({ ok: false, code: "nothing_to_reset", cleared: [] });
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 7 })).toMatchObject({
			ok: false,
			code: "nothing_to_reset",
		});
	});
});
