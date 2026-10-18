import { describe, expect, it } from "vitest";
import {
	BUILTIN_ROLE_IDS,
	customRoleIdError,
	HIDDEN_ROLE_IDS,
	modelRoleRefs,
	PRESET_ROLES,
	ROLE_GROUPS,
	roleGroup,
	roleSelectors,
} from "../../resources/gui-bridge/model-role-contracts";

describe("role groups", () => {
	it("list 14 of stock's 15 built-in roles by purpose and hide the memory role (ai-memory replaced stock's backends)", () => {
		expect(ROLE_GROUPS.map(group => [group.id, group.roles])).toEqual([
			["conversation", ["default", "slow", "smol", "plan"]],
			["agent", ["task", "advisor", "commit", "tiny"]],
			["io", ["vision", "image", "web", "speech", "dictation", "judge"]],
		]);
		expect(HIDDEN_ROLE_IDS).toEqual(["memory"]);
		expect(BUILTIN_ROLE_IDS).toHaveLength(15);
		expect(new Set(BUILTIN_ROLE_IDS).size).toBe(15);
	});

	it("lists a custom role under Custom roles and an unknown built-in by stock's own split", () => {
		expect(roleGroup("smol", "chat", true)).toBe("conversation");
		expect(roleGroup("judge", "kind", true)).toBe("io");
		expect(roleGroup("review", "chat", false)).toBe("custom");
		// A built-in of a newer omp: kind roles go to input & output, the rest to agent work.
		expect(roleGroup("future-kind", "kind", true)).toBe("io");
		expect(roleGroup("future-chat", "chat", true)).toBe("agent");
	});
});

describe("preset roles", () => {
	it("fall back only to built-in roles and never repeat or shadow one", () => {
		const ids = PRESET_ROLES.map(role => role.id);
		expect(ids).toEqual(["explore", "review", "debug", "docs", "test", "design"]);
		expect(new Set(ids).size).toBe(ids.length);
		for (const role of PRESET_ROLES) {
			expect(BUILTIN_ROLE_IDS).not.toContain(role.id);
			expect(customRoleIdError(role.id, [])).toBeUndefined();
			for (const fallback of role.fallback) expect(BUILTIN_ROLE_IDS).toContain(fallback);
		}
	});

	it("select the role first, then what an agent follows while it is empty", () => {
		expect(roleSelectors("review")).toEqual(["@review", "@slow", "@task"]);
		expect(roleSelectors("explore")).toEqual(["@explore", "@smol", "@task"]);
		expect(roleSelectors("test")).toEqual(["@test", "@task"]);
		// A role of the user's own has no fallback of its own.
		expect(roleSelectors("mine")).toEqual(["@mine"]);
	});
});

describe("customRoleIdError", () => {
	it("accepts short lowercase ids and refuses what stock owns, what exists and malformed ids", () => {
		expect(customRoleIdError("release_bot", ["review"])).toBeUndefined();
		expect(customRoleIdError("", [])).toBe("empty");
		expect(customRoleIdError("Release", [])).toBe("format");
		expect(customRoleIdError("release bot", [])).toBe("format");
		expect(customRoleIdError("1st", [])).toBe("format");
		expect(customRoleIdError("a:high", [])).toBe("format");
		expect(customRoleIdError("a/b", [])).toBe("format");
		expect(customRoleIdError("x".repeat(25), [])).toBe("format");
		expect(customRoleIdError("smol", [])).toBe("builtin");
		expect(customRoleIdError("default", [])).toBe("builtin");
		expect(customRoleIdError("review", ["review"])).toBe("exists");
	});
});

describe("modelRoleRefs", () => {
	it("reads the roles an agent's model lists, however it is written", () => {
		expect(modelRoleRefs(["@review", "@slow:high", "anthropic/sonnet", "@task"])).toEqual(["review", "slow", "task"]);
		expect(modelRoleRefs("@docs, @smol")).toEqual(["docs", "smol"]);
		expect(modelRoleRefs(["@review", "@review"])).toEqual(["review"]);
		expect(modelRoleRefs(undefined)).toEqual([]);
		expect(modelRoleRefs(["openai/gpt-5"])).toEqual([]);
	});
});
