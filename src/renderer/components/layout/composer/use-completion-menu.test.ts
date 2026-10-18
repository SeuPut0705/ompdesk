/**
 * applyCompletion contract: the shared completion-apply helper used by the
 * composer's model-delegation (`^selector`) menu among others. It must replace
 * ONLY the provider's [rangeStart, rangeEnd) prefix, never consume text after
 * the live caret, place the caret right after the inserted value, and refuse to
 * apply a stale menu once the caret has moved away from rangeEnd.
 */
import { describe, expect, it } from "vitest";
import type { AvailableCommand } from "../../../../shared/rpc-types";
import {
	applyCompletion,
	arrowKeepsMenu,
	type CompletionItem,
	type CompletionMenu,
	midPromptSkillMatches,
	rankSlashCommands,
	sameCompletionMenu,
	unknownSlashCommand,
} from "./use-completion-menu";

function menu(rangeStart: number, rangeEnd: number): CompletionMenu {
	return { source: "model", rangeStart, rangeEnd, items: [], index: 0 };
}

const item: CompletionItem = { value: "^anthropic/claude ", label: "^anthropic/claude" };

describe("applyCompletion", () => {
	it("replaces the ^prefix with the selector and lands the caret after it", () => {
		const result = applyCompletion("review ^cl", 10, menu(7, 10), item);
		expect(result).toEqual({ text: "review ^anthropic/claude ", caret: 7 + item.value.length });
	});

	it("preserves text after the caret instead of consuming it", () => {
		const result = applyCompletion("^cl please", 3, menu(0, 3), { value: "^x ", label: "^x" });
		expect(result).toEqual({ text: "^x  please", caret: 3 });
	});

	it("refuses to apply a stale menu once the caret moved off rangeEnd", () => {
		expect(applyCompletion("review ^cl", 9, menu(7, 10), item)).toBeNull();
	});
});

describe("midPromptSkillMatches", () => {
	// The cases stock's own doc names for `midPromptSkillTokenMatches` (pi-tui autocomplete.ts).
	it("lists every skill for the bare slash and any prefix of skill:", () => {
		for (const token of ["", "s", "skill", "skill:"]) expect(midPromptSkillMatches(token, "skill:tdd")).toBe(true);
	});

	it("matches the bare name or one of its hyphen segments from their start", () => {
		expect(midPromptSkillMatches("hum", "skill:humanizer")).toBe(true);
		expect(midPromptSkillMatches("last", "skill:research-last30days")).toBe(true);
		expect(midPromptSkillMatches("ast", "skill:research-last30days")).toBe(false);
	});

	it("matches an explicit skill: query against the name or description as a subsequence", () => {
		expect(midPromptSkillMatches("skill:rl3", "skill:research-last30days")).toBe(true);
		expect(midPromptSkillMatches("skill:dcs", "skill:docs")).toBe(true);
		// Stock scores the whole token, `skill:` included, against the description too.
		expect(midPromptSkillMatches("skill:pdf", "skill:docs", "skill: read pdf files")).toBe(true);
		expect(midPromptSkillMatches("skill:zz", "skill:docs", "Read PDF files")).toBe(false);
	});

	it("never offers a command for a stray word in prose", () => {
		expect(midPromptSkillMatches("re", "retry")).toBe(false);
		expect(midPromptSkillMatches("re", "skill:tdd")).toBe(false);
	});
});

describe("arrowKeepsMenu (←/→ close the menu only when they leave the token)", () => {
	const at = (source: CompletionMenu["source"], rangeStart: number) => ({ source, rangeStart });

	it("keeps an @ menu while the caret stays inside the token, in both directions", () => {
		// `see @readme and more`, the token spans 4..11.
		const text = "see @readme and more";
		const menu = at("mention", 4);
		expect(arrowKeepsMenu(text, menu, "ArrowLeft", 11)).toBe(true);
		expect(arrowKeepsMenu(text, menu, "ArrowLeft", 6)).toBe(true);
		expect(arrowKeepsMenu(text, menu, "ArrowRight", 5)).toBe(true);
		expect(arrowKeepsMenu(text, menu, "ArrowRight", 10)).toBe(true);
	});

	it("closes it when the arrow steps in front of the @ or off the end of the token", () => {
		const text = "see @readme and more";
		const menu = at("mention", 4);
		expect(arrowKeepsMenu(text, menu, "ArrowLeft", 5)).toBe(false); // caret lands in front of the @
		expect(arrowKeepsMenu(text, menu, "ArrowRight", 11)).toBe(false); // onto the space
		expect(arrowKeepsMenu("see @re", menu, "ArrowRight", 7)).toBe(false); // nothing to the right
		expect(arrowKeepsMenu(text, menu, "ArrowLeft", 0)).toBe(false);
	});

	it("reads an open quote and the other delimiters the way the token does", () => {
		const quoted = 'open @"My Re and more';
		expect(arrowKeepsMenu(quoted, at("mention", 5), "ArrowRight", 9)).toBe(true); // the space is inside the quote
		expect(arrowKeepsMenu("@a=b", at("mention", 0), "ArrowRight", 2)).toBe(false); // `=` ends a bare token
	});

	it("follows the other menus' tokens", () => {
		expect(arrowKeepsMenu("/plan x", at("command", 0), "ArrowLeft", 5)).toBe(true);
		expect(arrowKeepsMenu("/plan x", at("command", 0), "ArrowRight", 5)).toBe(false);
		expect(arrowKeepsMenu("a $tdd b", at("skill", 2), "ArrowLeft", 5)).toBe(true);
		expect(arrowKeepsMenu("a $tdd b", at("skill", 2), "ArrowLeft", 3)).toBe(false);
		expect(arrowKeepsMenu("a ^cl b", at("model", 2), "ArrowRight", 3)).toBe(true);
		expect(arrowKeepsMenu("x :smi y", at("emoji", 2), "ArrowLeft", 5)).toBe(true);
		expect(arrowKeepsMenu("pr #12", at("github-ref", 3), "ArrowLeft", 5)).toBe(true);
		expect(arrowKeepsMenu("pr #12", at("github-ref", 3), "ArrowLeft", 4)).toBe(false);
	});

	it("keeps a Hangul tail of a slash name in the token", () => {
		expect(arrowKeepsMenu("/pla한", at("command", 0), "ArrowLeft", 5)).toBe(true);
	});

	it("spans a slash command's argument menu, and steps over an emoji whole", () => {
		expect(arrowKeepsMenu("/model gp", at("slash-arg", 7), "ArrowLeft", 9)).toBe(true);
		expect(arrowKeepsMenu("/model gp", at("slash-arg", 7), "ArrowLeft", 7)).toBe(false);
		expect(arrowKeepsMenu("@a😀b", at("mention", 0), "ArrowLeft", 4)).toBe(true);
		expect(arrowKeepsMenu("@😀", at("mention", 0), "ArrowLeft", 3)).toBe(true);
		expect(arrowKeepsMenu("@😀", at("mention", 0), "ArrowLeft", 1)).toBe(false);
	});
});

describe("unknownSlashCommand", () => {
	const commands = [
		{ name: "plan", description: "", source: "builtin" },
		{ name: "model", description: "", source: "builtin", aliases: ["m"] },
	] as AvailableCommand[];

	it("names a command-shaped first word that no command or alias has", () => {
		expect(unknownSlashCommand("/zzzz", commands)).toBe("zzzz");
		expect(unknownSlashCommand("/Zzzz more words", commands)).toBe("Zzzz");
		expect(unknownSlashCommand("/skill:nope go", commands)).toBe("skill:nope");
	});

	it("accepts a name, an alias and any case of either", () => {
		expect(unknownSlashCommand("/plan", commands)).toBeNull();
		expect(unknownSlashCommand("/PLAN do it", commands)).toBeNull();
		expect(unknownSlashCommand("/m gpt", commands)).toBeNull();
	});

	it("ignores a draft that is not a slash command, a path, or a list not loaded yet", () => {
		expect(unknownSlashCommand("hello /zzzz", commands)).toBeNull();
		expect(unknownSlashCommand("/usr/bin/env", commands)).toBeNull();
		expect(unknownSlashCommand("/", commands)).toBeNull();
		expect(unknownSlashCommand("/zzzz", [])).toBeNull();
	});
});

describe("rankSlashCommands", () => {
	const commands = [
		{ name: "skill:team-plan", description: "", source: "skill" },
		{ name: "plan", description: "", source: "builtin" },
		{ name: "planner", description: "", source: "builtin" },
		{ name: "replan", description: "", source: "builtin", aliases: ["rp"] },
	] as AvailableCommand[];

	it("lists exact before prefix before substring, each in stock's order", () => {
		expect(rankSlashCommands(commands, "plan").map(command => command.name)).toEqual([
			"plan",
			"planner",
			"skill:team-plan",
			"replan",
		]);
	});

	it("counts an alias as the name, and keeps everything for an empty query", () => {
		expect(rankSlashCommands(commands, "rp").map(command => command.name)).toEqual(["replan"]);
		expect(rankSlashCommands(commands, "")).toHaveLength(4);
	});
});

describe("sameCompletionMenu", () => {
	const base: CompletionMenu = {
		source: "mention",
		rangeStart: 0,
		rangeEnd: 2,
		index: 3,
		items: [{ value: "@a.ts ", label: "a.ts", highlights: [[0, 1]] }],
		total: 1,
	};

	it("treats a re-derivation with the same rows, spans and counts as no change", () => {
		expect(sameCompletionMenu(base, { ...base, index: 0 })).toBe(true);
	});

	it("sees a changed highlight, total or cut flag as a change", () => {
		const moved = {
			...base,
			items: [{ value: "@a.ts ", label: "a.ts", highlights: [[1, 2]] as [number, number][] }],
		};
		expect(sameCompletionMenu(base, moved)).toBe(false);
		expect(sameCompletionMenu(base, { ...base, total: 5 })).toBe(false);
		expect(sameCompletionMenu(base, { ...base, truncated: true })).toBe(false);
	});
});
