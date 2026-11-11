import { describe, expect, it, vi } from "vitest";
import {
	type ResetAccountStatus,
	type ResetCreditDetail,
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
/** A provider whose stock redeem does not read the offer first: OMPdesk reads it, then redeems. */
const codexStatus: ResetAccountStatus = { ...status, provider: "openai-codex" };
const codexAccount: ResetUsageAccount = {
	...account,
	target: { provider: "openai-codex", credentialId: 7, creditId: "grant_1" },
};
function surface(selected: ResetUsageAccount = codexAccount, statuses: ResetAccountStatus[] = [codexStatus]) {
	const redeem = vi.fn(
		async (): Promise<{ ok: boolean; code: string; email?: string; reason?: string; cleared?: string[] }> => ({
			ok: true,
			code: "reset",
			cleared: ["anthropic:5h"],
		}),
	);
	const list = vi.fn(async (provider: string) => statuses.filter(candidate => candidate.provider === provider));
	const fake: ResetPassSurface = {
		verifiesOffer: provider => provider === "anthropic",
		list,
		accounts: () => [selected],
		redeem,
		describe: (outcome, label) => `${label}: ${outcome.code}`,
	};
	return { fake, redeem, list };
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
		expect(await redeemResetPass(fake, { provider: "openai-codex", credentialId: 7, creditId: "grant_1" })).toEqual({
			ok: true,
			code: "reset",
			message: "account 7: reset",
			cleared: ["anthropic:5h"],
		});
		expect(redeem).toHaveBeenCalledWith(codexAccount.target);
	});
	it("does not spend a changed confirmed offer", async () => {
		const { fake, redeem } = surface();
		expect(
			await redeemResetPass(fake, { provider: "openai-codex", credentialId: 7, creditId: "old-grant" }),
		).toMatchObject({ ok: false, code: "offer_changed" });
		expect(redeem).not.toHaveBeenCalled();
	});
	it("refuses stock ineligibility, listing failures, absent accounts and unsupported providers", async () => {
		const { fake, redeem } = surface({ ...codexAccount, redeemableCount: 0, unavailableReason: "cooldown" });
		expect(await redeemResetPass(fake, { provider: "openai-codex", credentialId: 7 })).toMatchObject({
			ok: false,
			code: "not_redeemable",
			reason: "cooldown",
		});
		expect(await redeemResetPass(fake, { provider: "openai-codex", credentialId: 99 })).toMatchObject({
			code: "no_account",
		});
		expect(await redeemResetPass(fake, { provider: "github-copilot", credentialId: 7 })).toMatchObject({
			code: "no_account",
		});
		const failed = surface(codexAccount, [{ ...codexStatus, error: "listing failed" }]);
		expect(await redeemResetPass(failed.fake, { provider: "openai-codex", credentialId: 7 })).toMatchObject({
			code: "credit_list_failed",
		});
		expect(redeem).not.toHaveBeenCalled();
		expect(failed.redeem).not.toHaveBeenCalled();
	});
	it("lets stock decide nothing-to-reset without claiming success", async () => {
		const { fake, redeem } = surface();
		redeem.mockResolvedValueOnce({ ok: false, code: "nothing_to_reset", cleared: [] });
		expect(await redeemResetPass(fake, { provider: "openai-codex", credentialId: 7 })).toMatchObject({
			ok: false,
			code: "nothing_to_reset",
		});
	});
});
describe("an account's passes by kind", () => {
	const day = (n: number) => new Date(Date.UTC(2027, 0, n)).toISOString();
	/** Two live Claude grants as stock 18.18.8 lists them: only the one Claude names next is usable. */
	const fable: ResetCreditDetail = {
		id: "g_fable",
		title: "Fable launch reset",
		remainingCount: 1,
		usable: true,
		requiresLimit: true,
		clears: ["anthropic:5h", "anthropic:7d:fable"],
		expiresAt: day(20),
		status: "available",
	};
	const regular: ResetCreditDetail = {
		id: "g_regular",
		title: "Limit reset",
		remainingCount: 2,
		usable: false,
		requiresLimit: false,
		clears: ["anthropic:7d", "anthropic:5h"],
		expiresAt: day(9),
		status: "unavailable",
	};
	const holding: ResetUsageAccount = {
		...account,
		availableCount: 3,
		target: { provider: "anthropic", credentialId: 7, creditId: "g_fable" },
		credit: fable,
	};

	it("lists one ticket per kind, the one stock can spend first, and names a pass only on that one", () => {
		const passes = shapeResetPasses(holding, [regular, fable]);
		expect(passes?.tickets).toEqual([
			{
				clears: ["anthropic:5h", "anthropic:7d:fable"],
				title: "Fable launch reset",
				count: 1,
				expiresAt: Date.parse(day(20)),
				early: false,
				creditId: "g_fable",
			},
			{
				clears: ["anthropic:7d", "anthropic:5h"],
				title: "Limit reset",
				count: 2,
				expiresAt: Date.parse(day(9)),
				early: true,
			},
		]);
		expect(passes?.tickets?.reduce((sum, ticket) => sum + ticket.count, 0)).toBe(passes?.count);
		expect(passes?.creditId).toBe("g_fable");
	});

	it("counts passes that reset the same limits as one kind, with the soonest expiry and the usable pass", () => {
		const second: ResetCreditDetail = { ...fable, id: "g_fable_2", usable: false, expiresAt: day(3) };
		const [first] = shapeResetPasses(holding, [second, fable, regular])?.tickets ?? [];
		expect(first).toMatchObject({ count: 2, expiresAt: Date.parse(day(3)), creditId: "g_fable" });
	});

	it("offers nothing to choose with one kind, and never counts a spent or expired pass as a kind", () => {
		expect(shapeResetPasses(holding, [fable])?.tickets).toBeUndefined();
		expect(shapeResetPasses(holding)?.tickets).toBeUndefined();
		expect(
			shapeResetPasses(holding, [
				fable,
				{ ...regular, status: "expired" },
				{ ...regular, id: "g_spent", remainingCount: 0, status: "redeemed" },
			])?.tickets,
		).toBeUndefined();
		// Codex credits name no limits: however many, they are one kind.
		expect(
			shapeResetPasses(codexAccount, [
				{ id: "c1", status: "available", expiresAt: day(3) },
				{ id: "c2", status: "available", expiresAt: day(9) },
			])?.tickets,
		).toBeUndefined();
	});
});
describe("a provider whose stock redeem checks the live offer itself (Claude)", () => {
	it("hands the confirmed pass straight to stock: no list of its own on the rate-limited lookup", async () => {
		const { fake, redeem, list } = surface(account, [status]);
		redeem.mockResolvedValueOnce({ ok: true, code: "reset", email: "home@example.com", cleared: ["anthropic:7d"] });
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 7, creditId: "grant_1" })).toEqual({
			ok: true,
			code: "reset",
			message: "home@example.com: reset",
			cleared: ["anthropic:7d"],
		});
		expect(list).not.toHaveBeenCalled();
		expect(redeem).toHaveBeenCalledTimes(1);
		expect(redeem).toHaveBeenCalledWith({ provider: "anthropic", credentialId: 7, creditId: "grant_1" });
	});
	it("reports stock's refusals as refusals, the account by its number when stock names none", async () => {
		const { fake, redeem, list } = surface(account, [status]);
		for (const refusal of [
			{ ok: false, code: "offer_changed" },
			{ ok: false, code: "credit_list_failed" },
			{ ok: false, code: "ineligible", reason: "cooldown" },
		]) {
			redeem.mockResolvedValueOnce(refusal);
			expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 7, creditId: "grant_1" })).toEqual({
				ok: false,
				code: refusal.code,
				message: `#7: ${refusal.code}`,
				...(refusal.reason ? { reason: refusal.reason } : {}),
			});
		}
		expect(list).not.toHaveBeenCalled();
	});
});
