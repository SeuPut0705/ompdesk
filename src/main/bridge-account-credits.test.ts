import { describe, expect, it } from "vitest";
import { accountCredits, creditKind, creditsInRaw, rawCredits } from "../../resources/gui-bridge/account-credits";

const window5h = { id: "anthropic:5h", amount: { used: 20, limit: 100, remaining: 80, unit: "percent" } };

describe("account credits from stock's usage limits", () => {
	it("reads a balance that is only what is left (Charm Hyper, Command Code)", () => {
		expect(accountCredits([{ id: "charm-hyper:credits", amount: { remaining: 1200, unit: "credits" } }])).toEqual({
			kind: "balance",
			limitId: "charm-hyper:credits",
			remaining: 1200,
			unit: "credits",
		});
		expect(
			accountCredits([{ id: "commandcode:balance", amount: { remaining: 7.5, unit: "credits" } }]),
		).toMatchObject({
			kind: "balance",
			remaining: 7.5,
		});
	});

	it("reads Factory's balance, reported as a cap of itself with `used: 0`, as a balance and no cap", () => {
		const factory = {
			id: "factory-droid:extra-balance",
			amount: { used: 0, limit: 12.4, remaining: 12.4, usedFraction: 0, remainingFraction: 1, unit: "usd" },
		};
		expect(accountCredits([window5h, factory])).toEqual({
			kind: "balance",
			limitId: "factory-droid:extra-balance",
			remaining: 12.4,
			unit: "usd",
		});
		expect(creditKind(factory.id)).toBe("balance");
	});

	it("reads Claude's extra usage as what is left of the month's cap, with the cap", () => {
		const extra = {
			id: "anthropic:extra",
			amount: { used: 14.8, limit: 50, remaining: 35.2, usedFraction: 0.296, unit: "usd" },
		};
		expect(accountCredits([window5h, extra])).toEqual({
			kind: "monthlyCap",
			limitId: "anthropic:extra",
			remaining: 35.2,
			limit: 50,
			unit: "usd",
		});
	});

	it("has nothing for zero, a spent cap, uncapped extra usage, an odd unit or no credit limit at all", () => {
		expect(
			accountCredits([{ id: "commandcode:balance", amount: { remaining: 0, unit: "credits" } }]),
		).toBeUndefined();
		const spent = { id: "anthropic:extra", amount: { used: 50, limit: 50, remaining: 0, unit: "usd" } };
		expect(accountCredits([spent])).toBeUndefined();
		// Extra usage with no monthly cap: stock reports what was spent, never what is left.
		const uncapped = { id: "anthropic:extra", amount: { used: 3, unit: "usd" } };
		expect(accountCredits([uncapped])).toBeUndefined();
		expect(
			accountCredits([{ id: "factory-droid:extra-balance", amount: { remaining: 5, unit: "unknown" } }]),
		).toBeUndefined();
		expect(accountCredits([{ id: "charm-hyper:credits", amount: { remaining: Number.NaN, unit: "credits" } }])).toBe(
			undefined,
		);
		expect(accountCredits([window5h])).toBeUndefined();
		expect(accountCredits([])).toBeUndefined();
	});

	it("counts only the limits stock reports as credits, never a quota window or a spend cap with a window", () => {
		expect(creditKind("anthropic:5h")).toBeUndefined();
		// Codex's spend cap is a window the gauges draw, not money left.
		expect(creditKind("openai-codex:spend-cap")).toBeUndefined();
		expect(creditKind("toString")).toBeUndefined();
		const spendCap = {
			id: "openai-codex:spend-cap",
			amount: { used: 10, limit: 100, remaining: 90, unit: "credits" },
		};
		expect(accountCredits([spendCap])).toBeUndefined();
	});

	it("reads ChatGPT's balance from the answer stock keeps as the report's raw, as the Codex CLI shows it", () => {
		expect(creditsInRaw("openai-codex")).toBe(true);
		expect(creditsInRaw("anthropic")).toBe(false);
		expect(creditsInRaw("toString")).toBe(false);
		const balance = { kind: "balance", limitId: "openai-codex:credits", remaining: 1234.5, unit: "credits" };
		// The provider sends the balance as a string.
		expect(
			rawCredits("openai-codex", { credits: { has_credits: true, unlimited: false, balance: "1234.5" } }),
		).toEqual(balance);
		expect(rawCredits("openai-codex", { credits: { has_credits: true, balance: 1234.5 } })).toEqual(balance);
		expect(rawCredits("openai-codex", { credits: { has_credits: true, unlimited: true, balance: "0" } })).toEqual({
			kind: "unlimited",
			limitId: "openai-codex:credits",
		});
		for (const credits of [
			{ has_credits: false, balance: "50" },
			{ has_credits: true, balance: "0" },
			{ has_credits: true, balance: "" },
			{ has_credits: true, balance: "soon" },
			{ has_credits: true },
			null,
		]) {
			expect(rawCredits("openai-codex", { credits })).toBeUndefined();
		}
		expect(rawCredits("openai-codex", {})).toBeUndefined();
		expect(rawCredits("openai-codex", null)).toBeUndefined();
		// Another provider's raw is never read, whatever it holds.
		expect(rawCredits("anthropic", { credits: { has_credits: true, balance: "5" } })).toBeUndefined();
	});
});
