/**
 * Pins the renderer copy to stock `pi-tui/src/prompt/skill-tokens.ts` and
 * `parseSkillInvocation` (pi-coding-agent/src/extensibility/skills.ts): the
 * leading and mid-prompt forms, namespaced names, and the drafts whose tokens
 * belong to another slash command or a local-execution sigil.
 */
import { describe, expect, it } from "vitest";
import type { AvailableCommand } from "../../shared/rpc-types";
import { allowsSkillTokens, unavailableSkillTokens } from "./skill-tokens";

const commands: AvailableCommand[] = [
	{ name: "skill:review", description: "" },
	{ name: "skill:team/deploy", description: "" },
];

describe("allowsSkillTokens", () => {
	it("follows stock's gates", () => {
		expect(allowsSkillTokens("/skill:foo bar")).toBe(true);
		expect(allowsSkillTokens("  fix the bug /skill:foo")).toBe(true);
		expect(allowsSkillTokens("/model /skill:foo")).toBe(false);
		expect(allowsSkillTokens("! ls /skill:foo")).toBe(false);
		expect(allowsSkillTokens("$ echo /skill:foo")).toBe(false);
		expect(allowsSkillTokens("$$ echo /skill:foo")).toBe(false);
		expect(allowsSkillTokens("$")).toBe(false);
		expect(allowsSkillTokens(`$\{x} /skill:foo`)).toBe(true);
		expect(allowsSkillTokens("$x /skill:foo")).toBe(true);
	});
});

describe("unavailableSkillTokens", () => {
	it("names tokens the session does not offer, once each", () => {
		expect(unavailableSkillTokens("fix the bug /skill:review focus on auth", commands)).toEqual([]);
		expect(unavailableSkillTokens("/skill:team/deploy now", commands)).toEqual([]);
		expect(unavailableSkillTokens("/skill:gone and /skill:gone\n/skill:off", commands)).toEqual(["gone", "off"]);
	});

	it("ignores text that is not a token and drafts stock reads verbatim", () => {
		expect(unavailableSkillTokens("see a/skill:gone and /skill:a/b/c", commands)).toEqual([]);
		expect(unavailableSkillTokens("/compact /skill:gone", commands)).toEqual([]);
		expect(unavailableSkillTokens("! run /skill:gone", commands)).toEqual([]);
	});

	it("knows nothing before the command list loads", () => {
		expect(unavailableSkillTokens("/skill:gone", [])).toEqual([]);
	});
});
