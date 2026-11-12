import { describe, expect, it, vi } from "vitest";
import {
	type ChosenAccount,
	type ChosenSpend,
	chosenClaims,
	type ResetCreditDetail,
	type ResetPassSurface,
	type ResetUsageAccount,
	redeemResetPass as redeemWith,
	STORED_OFFER_MAX_AGE_MS,
	shapeResetPasses,
} from "../../resources/gui-bridge/reset-passes-core";

/** A redeem with nothing remembered from an earlier one, unless the test hands its own memory in. */
const redeemResetPass = (fake: ResetPassSurface, request: Parameters<typeof redeemWith>[1], claims = chosenClaims()) =>
	redeemWith(fake, request, claims);

const account: ResetUsageAccount = {
	label: "account 7",
	target: { provider: "anthropic", credentialId: 7, creditId: "grant_1" },
	availableCount: 2,
	redeemableCount: 1,
	expiresAt: "2026-10-22T00:00:00Z",
	credit: { id: "grant_1", title: "Reset", requiresLimit: false, clears: ["anthropic:5h"] },
};
/** A Codex account as stock's usage report gives it: its credits carry no id. */
const codexAccount: ResetUsageAccount = {
	...account,
	target: { provider: "openai-codex", credentialId: 7 },
};
function surface() {
	const redeem = vi.fn(
		async (): Promise<{ ok: boolean; code: string; email?: string; reason?: string; cleared?: string[] }> => ({
			ok: true,
			code: "reset",
			cleared: ["anthropic:5h"],
		}),
	);
	/** An account whose offer holds nothing that can be sent, unless a test gives it one. */
	const account = vi.fn(
		async (): Promise<ChosenAccount | { code: string }> => ({
			offer: { credits: [] },
			spend: async () => ({ ok: false, code: "unscripted", status: 0 }),
		}),
	);
	const settle = vi.fn(async () => {});
	const fake: ResetPassSurface = {
		redeem,
		describe: (outcome, label) => `${label}: ${outcome.code}`,
		account,
		settle,
	};
	return { fake, redeem, account, settle };
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
describe("a Codex pass: stock's redeem reads the account's list itself", () => {
	it("hands the redeem to stock with no read of its own, and its outcome back", async () => {
		const { fake, redeem, account: read } = surface();
		expect(await redeemResetPass(fake, { provider: "openai-codex", credentialId: 7 })).toEqual({
			ok: true,
			code: "reset",
			message: "#7: reset",
			cleared: ["anthropic:5h"],
		});
		expect(redeem).toHaveBeenCalledTimes(1);
		expect(redeem).toHaveBeenCalledWith({ provider: "openai-codex", credentialId: 7 });
		expect(read).not.toHaveBeenCalled();
	});
	it("reports stock's refusals as they are: no Codex credit id is stored, so a failed read cannot be stood in for", async () => {
		const { fake, redeem, account: read } = surface();
		for (const code of ["credit_list_failed", "no_credit", "nothing_to_reset", "no_account", "already_redeemed"]) {
			redeem.mockResolvedValueOnce({ ok: false, code });
			expect(await redeemResetPass(fake, { provider: "openai-codex", credentialId: 7 })).toMatchObject({
				ok: false,
				code,
			});
		}
		expect(read).not.toHaveBeenCalled();
	});
	it("passes a named pass to stock as it is", async () => {
		const { fake, redeem } = surface();
		await redeemResetPass(fake, { provider: "openai-codex", credentialId: 7, creditId: "grant_1" });
		expect(redeem).toHaveBeenCalledWith({ provider: "openai-codex", credentialId: 7, creditId: "grant_1" });
	});
});
describe("an account's passes by kind", () => {
	const day = (n: number) => new Date(Date.UTC(2027, 0, n)).toISOString();
	/** Two live Claude grants as stock 18.18.8 lists them: it marks only the one Claude names next usable. */
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

	it("lists one ticket per kind, the one the provider spends next first, each naming the pass a pick of it spends", () => {
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
				creditId: "g_regular",
			},
		]);
		expect(passes?.tickets?.reduce((sum, ticket) => sum + ticket.count, 0)).toBe(passes?.count);
		expect(passes?.creditId).toBe("g_fable");
	});

	it("names the soonest pass of a kind the provider does not spend next, and none for a kind that is paused", () => {
		const later: ResetCreditDetail = { ...regular, id: "g_regular_later", expiresAt: day(15) };
		const paused: ResetCreditDetail = {
			id: "g_opus",
			remainingCount: 1,
			usable: false,
			clears: ["anthropic:7d:opus"],
			expiresAt: day(2),
			status: "paused",
		};
		const tickets = shapeResetPasses(holding, [paused, later, regular, fable])?.tickets ?? [];
		expect(tickets.map(ticket => ticket.creditId)).toEqual(["g_fable", "g_regular", undefined]);
		expect(tickets[1]).toMatchObject({ count: 4, expiresAt: Date.parse(day(9)) });
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
describe("a pass picked that Claude does not name next", () => {
	const fable: ResetCreditDetail = { id: "g_fable", remainingCount: 1, usable: true, status: "available" };
	const regular: ResetCreditDetail = { id: "g_regular", remainingCount: 2, usable: false, status: "unavailable" };
	const request = { provider: "anthropic", credentialId: 7, creditId: "g_regular" };
	/** Stock refuses the pick (`offer_changed`); the account's offer is `credits` with `next` named next. */
	function picked(credits: ResetCreditDetail[] = [fable, regular], next: string | null = "g_fable") {
		const world = surface();
		world.redeem.mockResolvedValue({ ok: false, code: "offer_changed", email: "home@example.com" });
		const spend = vi.fn(
			async (): Promise<ChosenSpend> => ({ ok: true, code: "reset", status: 200, cleared: ["anthropic:7d"] }),
		);
		world.account.mockResolvedValue({
			email: "home@example.com",
			offer: { ...(next ? { nextCreditId: next } : {}), credits },
			spend,
		});
		return { ...world, spend };
	}

	it("reads the account's offer once and spends exactly that pass", async () => {
		const { fake, account: read, spend, settle } = picked();
		expect(await redeemResetPass(fake, request)).toEqual({
			ok: true,
			code: "reset",
			message: "home@example.com: reset",
			cleared: ["anthropic:7d"],
		});
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith("anthropic", 7, true);
		expect(spend).toHaveBeenCalledTimes(1);
		expect(spend).toHaveBeenCalledWith({ ...regular, usable: true }, expect.stringMatching(/^[\w-]{8,64}$/));
		expect(settle).toHaveBeenCalledWith("anthropic");
	});

	it("touches nothing of its own while stock answers anything but a changed offer", async () => {
		const { fake, redeem, account: read } = picked();
		for (const answer of [
			{ ok: true, code: "reset" },
			{ ok: false, code: "ineligible" },
			{ ok: false, code: "reset_in_progress" },
			{ ok: false, code: "reset_unconfirmed" },
		]) {
			redeem.mockResolvedValueOnce(answer);
			expect(await redeemResetPass(fake, request)).toMatchObject(answer);
		}
		// A redeem that confirmed no pass has none to send by itself.
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 7 })).toMatchObject({
			code: "offer_changed",
		});
		expect(read).not.toHaveBeenCalled();
	});

	it("leaves stock's refusal standing when the pick is not a pass that can be sent", async () => {
		for (const [credits, next] of [
			[[fable], "g_fable"],
			[[fable, { ...regular, remainingCount: 0, status: "redeemed" }], "g_fable"],
			[[fable, { ...regular, status: "expired" }], "g_fable"],
			[[fable, { ...regular, status: "paused" }], "g_fable"],
			// The offer names the pick next after all, or names nothing: stock's own redeem is the one to ask again.
			[[fable, regular], "g_regular"],
			[[fable, regular], null],
		] as const) {
			const { fake, spend, settle } = picked([...credits], next);
			expect(await redeemResetPass(fake, request)).toMatchObject({ ok: false, code: "offer_changed" });
			expect(spend).not.toHaveBeenCalled();
			expect(settle).not.toHaveBeenCalled();
		}
	});

	it("reports an account it cannot read without sending anything", async () => {
		for (const code of ["no_account", "account_unavailable", "credit_list_failed"]) {
			const { fake, account: read, spend } = picked();
			read.mockResolvedValue({ code });
			expect(await redeemResetPass(fake, request)).toMatchObject({ ok: false, code });
			expect(spend).not.toHaveBeenCalled();
		}
	});

	it("repeats the same claim for a pass whose spend was never answered, and a new one once it was", async () => {
		const { fake, spend, settle } = picked();
		const claims = chosenClaims();
		const ids = () => spend.mock.calls.map(call => (call as unknown as [unknown, string])[1]);
		spend.mockResolvedValueOnce({ ok: false, code: "network_error", status: 0 });
		spend.mockResolvedValueOnce({ ok: false, code: "http_502", status: 502 });
		spend.mockResolvedValueOnce({ ok: false, code: "nothing_to_reset", status: 200 });
		expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "network_error" });
		expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "http_502" });
		expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "nothing_to_reset" });
		expect(settle).not.toHaveBeenCalled();
		await redeemResetPass(fake, request, claims);
		const [first, second, third, fourth] = ids();
		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(fourth).not.toBe(first);
	});

	describe("never claims one pass under two request ids while the first may have applied", () => {
		const lost: ChosenSpend = { ok: false, code: "network_error", status: 0 };
		const requestIds = (spend: { mock: { calls: unknown[][] } }) => spend.mock.calls.map(call => call[1]);

		it("repeats its unanswered claim itself once the provider names that pass next: stock would send a new one", async () => {
			const { fake, redeem, account: read, spend } = picked();
			const claims = chosenClaims();
			spend.mockResolvedValueOnce(lost);
			await redeemResetPass(fake, request, claims);
			// The provider now names the picked pass next: stock's redeem would spend it under an id of its own.
			redeem.mockResolvedValue({ ok: true, code: "reset" });
			read.mockResolvedValue({ offer: { nextCreditId: "g_regular", credits: [fable, regular] }, spend });
			spend.mockResolvedValueOnce({ ok: false, code: "already_redeemed", status: 200 });

			expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "already_redeemed" });
			expect(redeem).toHaveBeenCalledTimes(1);
			const [first, second] = requestIds(spend);
			expect(second).toBe(first);
			// That answer ended the claim: the next spend of the pass is stock's again.
			expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: true, code: "reset" });
			expect(redeem).toHaveBeenCalledTimes(2);
			expect(spend).toHaveBeenCalledTimes(2);
		});

		it("sends nothing more when a use of the pass is gone after the unanswered claim: it applied", async () => {
			const { fake, redeem, account: read, spend, settle } = picked();
			const claims = chosenClaims();
			spend.mockResolvedValueOnce(lost);
			await redeemResetPass(fake, request, claims);
			read.mockResolvedValue({
				offer: { nextCreditId: "g_regular", credits: [fable, { ...regular, remainingCount: 1 }] },
				spend,
			});

			expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "already_redeemed" });
			expect(spend).toHaveBeenCalledTimes(1);
			expect(redeem).toHaveBeenCalledTimes(1);
			expect(settle).toHaveBeenCalledWith("anthropic");
		});

		it("keeps each pass's unanswered claim apart", async () => {
			const opus: ResetCreditDetail = { id: "g_opus", remainingCount: 1, usable: false, status: "unavailable" };
			const { fake, spend } = picked([fable, regular, opus]);
			const claims = chosenClaims();
			spend.mockResolvedValueOnce(lost);
			await redeemResetPass(fake, request, claims);
			await redeemResetPass(fake, { ...request, creditId: "g_opus" }, claims);
			await redeemResetPass(fake, request, claims);
			const [regularFirst, opusOnly, regularAgain] = requestIds(spend);
			expect(regularAgain).toBe(regularFirst);
			expect(opusOnly).not.toBe(regularFirst);
		});

		it("forgets its claim of a pass that left the offer, and says the offer changed", async () => {
			const { fake, redeem, account: read, spend } = picked();
			const claims = chosenClaims();
			spend.mockResolvedValueOnce(lost);
			await redeemResetPass(fake, request, claims);
			read.mockResolvedValue({ offer: { nextCreditId: "g_fable", credits: [fable] }, spend });
			expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "offer_changed" });
			expect(spend).toHaveBeenCalledTimes(1);
			expect(redeem).toHaveBeenCalledTimes(1);
			expect(claims.unsettled.size).toBe(0);
		});

		it("leaves a pass alone whose claim by stock went unanswered: stock holds that claim's id", async () => {
			const { fake, redeem, account: read, spend } = picked();
			const claims = chosenClaims();
			for (const unanswered of ["network_error", "malformed_response", "http_502", "unavailable"]) {
				// Stock claimed the pass while the provider named it next, and no answer came back.
				redeem.mockResolvedValueOnce({ ok: false, code: unanswered });
				expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: unanswered });
				// The provider names another pass next now: stock refuses, and this path must not claim it anew.
				expect(await redeemResetPass(fake, request, claims)).toMatchObject({
					ok: false,
					code: "reset_unconfirmed",
				});
				// Stock's own answer to that claim frees the pass again.
				redeem.mockResolvedValueOnce({ ok: false, code: "already_redeemed" });
				await redeemResetPass(fake, request, claims);
			}
			expect(read).not.toHaveBeenCalled();
			expect(spend).not.toHaveBeenCalled();
			expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: true, code: "reset" });
			expect(spend).toHaveBeenCalledTimes(1);
		});
	});

	it("refuses a second spend on an account while one is under way, and sends it nothing", async () => {
		const { fake, spend } = picked();
		const claims = chosenClaims();
		const answer = Promise.withResolvers<ChosenSpend>();
		spend.mockReturnValueOnce(answer.promise);
		const first = redeemResetPass(fake, request, claims);
		await vi.waitFor(() => expect(spend).toHaveBeenCalledTimes(1));
		expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "reset_in_progress" });
		expect(spend).toHaveBeenCalledTimes(1);
		answer.resolve({ ok: true, code: "reset", status: 200 });
		expect(await first).toMatchObject({ ok: true, code: "reset" });
	});
});
describe("a Claude pass stock's redeem checks and spends itself", () => {
	it("hands the confirmed pass straight to stock: no read of its own on the rate-limited lookup", async () => {
		const { fake, redeem, account: read } = surface();
		redeem.mockResolvedValueOnce({ ok: true, code: "reset", email: "home@example.com", cleared: ["anthropic:7d"] });
		expect(await redeemResetPass(fake, { provider: "anthropic", credentialId: 7, creditId: "grant_1" })).toEqual({
			ok: true,
			code: "reset",
			message: "home@example.com: reset",
			cleared: ["anthropic:7d"],
		});
		expect(read).not.toHaveBeenCalled();
		expect(redeem).toHaveBeenCalledTimes(1);
		expect(redeem).toHaveBeenCalledWith({ provider: "anthropic", credentialId: 7, creditId: "grant_1" });
	});
	it("reports stock's refusals as refusals, the account by its number when stock names none", async () => {
		const { fake, redeem } = surface();
		for (const refusal of [
			{ ok: false, code: "offer_changed" },
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
	});
});
describe("a confirmed pass whose live check the provider turns away", () => {
	/** The pass the dialog showed, as the last usage read of the account lists it. */
	const grant = {
		id: "grant_1",
		program: "cedar_ember",
		remainingCount: 1,
		usable: true,
		status: "available",
		clears: ["anthropic:5h"],
	};
	const request = { provider: "anthropic", credentialId: 7, creditId: "grant_1" };
	/** Stock's redeem could not read the offer (429); the bridge holds the account's last read, `readAgo` old. */
	function throttled(readAgo = 60_000, credits: ResetCreditDetail[] = [grant]) {
		const world = surface();
		world.redeem.mockResolvedValue({ ok: false, code: "credit_list_failed", email: "home@example.com" });
		const spend = vi.fn(
			async (): Promise<ChosenSpend> => ({ ok: true, code: "reset", status: 200, cleared: ["anthropic:5h"] }),
		);
		const stored = { nextCreditId: "grant_1", credits, storedAt: Date.now() - readAgo };
		world.account.mockResolvedValue({ email: "home@example.com", offer: stored, spend });
		return { ...world, spend };
	}

	it("spends exactly that pass once from the last read, with no second lookup", async () => {
		const { fake, redeem, account: read, spend, settle } = throttled();
		expect(await redeemResetPass(fake, request)).toEqual({
			ok: true,
			code: "reset",
			message: "home@example.com: reset",
			cleared: ["anthropic:5h"],
		});
		expect(redeem).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith("anthropic", 7, false);
		expect(spend).toHaveBeenCalledTimes(1);
		expect(spend).toHaveBeenCalledWith({ ...grant, usable: true }, expect.stringMatching(/^[\w-]{8,64}$/));
		expect(settle).toHaveBeenCalledWith("anthropic");
	});

	it("spends nothing when no read of the bound's age stands in, and says so", async () => {
		const old = throttled(STORED_OFFER_MAX_AGE_MS + 1_000);
		expect(await redeemResetPass(old.fake, request)).toEqual({
			ok: false,
			code: "stale_offer",
			// What a paired device whose OMPdesk predates the code shows (stock's sentence would say "not confirmed").
			message:
				"home@example.com: the provider's check failed and no read of this account's passes from the last 15 minutes stands in for it, so nothing was spent.",
		});
		const none = throttled();
		none.account.mockResolvedValue({ email: "home@example.com", spend: none.spend });
		expect(await redeemResetPass(none.fake, request)).toMatchObject({ ok: false, code: "stale_offer" });
		expect(old.spend).not.toHaveBeenCalled();
		expect(none.spend).not.toHaveBeenCalled();
	});

	it("says the offer changed, unspent, when the last read no longer lists the pass as one to spend", async () => {
		for (const credits of [
			[],
			[{ ...grant, remainingCount: 0, status: "redeemed" }],
			[{ ...grant, status: "paused" }],
			[{ ...grant, expiresAt: new Date(Date.now() - 1_000).toISOString() }],
		]) {
			const { fake, spend, settle } = throttled(60_000, credits);
			expect(await redeemResetPass(fake, request)).toMatchObject({ ok: false, code: "offer_changed" });
			expect(spend).not.toHaveBeenCalled();
			expect(settle).not.toHaveBeenCalled();
		}
	});

	it("never sends a session reset from a stored read: its claim carries no request id", async () => {
		const session = { ...grant, id: "juniper_tide", program: "juniper_tide" };
		const { fake, spend } = throttled(60_000, [session]);
		expect(await redeemResetPass(fake, { ...request, creditId: "juniper_tide" })).toMatchObject({
			ok: false,
			code: "credit_list_failed",
		});
		expect(spend).not.toHaveBeenCalled();
	});

	it("reports the provider's own refusal of the claim, sent once", async () => {
		const { fake, spend, settle } = throttled();
		spend.mockResolvedValueOnce({ ok: false, code: "already_redeemed", status: 200 });
		expect(await redeemResetPass(fake, request)).toMatchObject({ ok: false, code: "already_redeemed" });
		expect(spend).toHaveBeenCalledTimes(1);
		expect(settle).not.toHaveBeenCalled();
	});

	it("repeats an unanswered claim under its own request id on the next click, before stock is asked", async () => {
		const { fake, redeem, account: read, spend } = throttled();
		const claims = chosenClaims();
		spend.mockResolvedValueOnce({ ok: false, code: "network_error", status: 0 });
		expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "network_error" });
		expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: true, code: "reset" });
		expect(redeem).toHaveBeenCalledTimes(1);
		expect(read.mock.calls).toEqual([
			["anthropic", 7, false],
			["anthropic", 7, true],
		]);
		const [first, second] = spend.mock.calls.map(call => (call as unknown as [unknown, string])[1]);
		expect(second).toBe(first);
	});

	it("refuses a second click while the first claim is unanswered, and sends it nothing", async () => {
		const { fake, spend } = throttled();
		const claims = chosenClaims();
		const answer = Promise.withResolvers<ChosenSpend>();
		spend.mockReturnValueOnce(answer.promise);
		const first = redeemResetPass(fake, request, claims);
		await vi.waitFor(() => expect(spend).toHaveBeenCalledTimes(1));
		expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "reset_in_progress" });
		answer.resolve({ ok: true, code: "reset", status: 200 });
		expect(await first).toMatchObject({ ok: true, code: "reset" });
		expect(spend).toHaveBeenCalledTimes(1);
	});

	it("never claims a pass whose claim by stock went unanswered: stock holds that claim's id", async () => {
		const { fake, redeem, spend } = throttled();
		const claims = chosenClaims();
		redeem.mockResolvedValueOnce({ ok: false, code: "network_error" });
		expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "network_error" });
		expect(await redeemResetPass(fake, request, claims)).toMatchObject({ ok: false, code: "reset_unconfirmed" });
		expect(spend).not.toHaveBeenCalled();
	});
});
