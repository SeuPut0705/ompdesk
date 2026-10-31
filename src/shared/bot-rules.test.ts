import { describe, expect, it } from "vitest";
import {
	BOT_RULE_ACTION_MAX,
	BOT_RULES_MAX,
	botRulesText,
	DEFAULT_BOT_RULES,
	newBotRuleId,
	parseBotRules,
} from "./bot-rules";

const behaviorOf = (id: string) => DEFAULT_BOT_RULES.find(rule => rule.id === id)?.behavior;

describe("DEFAULT_BOT_RULES", () => {
	it("asks before the actions that reach outside, and only follows the owner's lead on push and merge", () => {
		for (const id of ["deploy", "force-push", "delete", "outside-messages", "payments", "secrets"])
			expect(behaviorOf(id), id).toBe("ask");
		for (const id of ["push", "merge"]) expect(behaviorOf(id), id).toBe("preapproved");
		for (const id of ["edits", "tests", "open-sessions"]) expect(behaviorOf(id), id).toBe("auto");
		expect(new Set(DEFAULT_BOT_RULES.map(rule => rule.id)).size).toBe(DEFAULT_BOT_RULES.length);
	});
});

describe("parseBotRules", () => {
	it("reads anything that is not an array as the defaults, copied", () => {
		for (const value of [undefined, null, "x", 3, { id: "a" }]) {
			const rules = parseBotRules(value);
			expect(rules).toEqual(DEFAULT_BOT_RULES);
			expect(rules[0]).not.toBe(DEFAULT_BOT_RULES[0]);
		}
	});

	it("keeps a stored list as it is, an empty one included", () => {
		const stored = [{ id: "a", action: "Update dependencies", behavior: "handoff" }];
		expect(parseBotRules(stored)).toEqual(stored);
		expect(parseBotRules([])).toEqual([]);
	});

	it("drops invalid and repeated entries and cleans the text", () => {
		const rules = parseBotRules([
			{ id: "a", action: "  Deploy \n  the   app ", behavior: "ask" },
			{ id: "a", action: "again", behavior: "auto" },
			{ id: "", action: "no id", behavior: "auto" },
			{ id: "b", action: "   ", behavior: "auto" },
			{ id: "c", action: "bad behavior", behavior: "sometimes" },
			{ id: 4, action: "numeric id", behavior: "auto" },
			{ id: "d", action: 5, behavior: "auto" },
			null,
			"text",
			{ id: "e", action: "x".repeat(BOT_RULE_ACTION_MAX + 50), behavior: "preapproved" },
		]);
		expect(rules).toEqual([
			{ id: "a", action: "Deploy the app", behavior: "ask" },
			{ id: "e", action: "x".repeat(BOT_RULE_ACTION_MAX), behavior: "preapproved" },
		]);
	});

	it("keeps at most BOT_RULES_MAX rules", () => {
		const many = Array.from({ length: BOT_RULES_MAX + 5 }, (_, index) => ({
			id: `r${index}`,
			action: `Action ${index}`,
			behavior: "auto",
		}));
		expect(parseBotRules(many)).toHaveLength(BOT_RULES_MAX);
	});
});

describe("botRulesText", () => {
	it("writes one English line per rule saying what the bot does", () => {
		expect(
			botRulesText([
				{ id: "1", action: "Edit code", behavior: "auto" },
				{ id: "2", action: "Push to a branch", behavior: "preapproved" },
				{ id: "3", action: "Deploy or release", behavior: "ask" },
				{ id: "4", action: "Merge\na branch", behavior: "handoff" },
			]),
		).toBe(
			[
				"- Edit code: take it without asking.",
				"- Push to a branch: take it only if the owner explicitly asked for it.",
				"- Deploy or release: ask the owner before taking it.",
				"- Merge a branch: do not take it; hand the step to the owner.",
			].join("\n"),
		);
		expect(botRulesText([])).toBe("");
	});
});

describe("newBotRuleId", () => {
	it("never repeats an id in use", () => {
		const rules = Array.from({ length: 20 }, () => ({ id: "", action: "a", behavior: "auto" as const }));
		const ids = new Set<string>();
		for (const rule of rules) {
			rule.id = newBotRuleId(rules);
			ids.add(rule.id);
		}
		expect(ids.size).toBe(20);
	});
});
