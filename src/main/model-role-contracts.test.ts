import { describe, expect, it } from "vitest";
import {
	BUILTIN_ROLE_IDS,
	HIDDEN_ROLE_IDS,
	ROLE_GROUPS,
	roleGroup,
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

	it("groups a listed role by purpose and an unknown built-in by stock's own split", () => {
		expect(roleGroup("smol", "chat")).toBe("conversation");
		expect(roleGroup("judge", "kind")).toBe("io");
		// A built-in of a newer omp: kind roles go to input & output, the rest to agent work.
		expect(roleGroup("future-kind", "kind")).toBe("io");
		expect(roleGroup("future-chat", "chat")).toBe("agent");
	});
});
