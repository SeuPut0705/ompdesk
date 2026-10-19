import { describe, expect, it } from "vitest";
import {
	HIDDEN_ROLE_IDS,
	HIDDEN_ROLES,
	ROLE_GROUPS,
	ROLE_ORDER,
	roleGroup,
} from "../../resources/gui-bridge/model-role-contracts";

describe("role groups", () => {
	it("order 14 of stock's roles by purpose and hide the memory role with its reason (ai-memory replaced stock's backends)", () => {
		expect(ROLE_GROUPS.map(group => [group.id, group.roles])).toEqual([
			["conversation", ["default", "slow", "smol", "plan"]],
			["agent", ["task", "advisor", "commit", "tiny"]],
			["io", ["vision", "image", "web", "speech", "dictation", "judge"]],
		]);
		expect(ROLE_ORDER).toHaveLength(14);
		expect(new Set(ROLE_ORDER).size).toBe(14);
		expect(HIDDEN_ROLE_IDS).toEqual(["memory"]);
		expect(HIDDEN_ROLES.memory).toContain("ai-memory");
		expect(ROLE_ORDER).not.toContain("memory");
	});

	it("groups a listed role by purpose and an unknown built-in by stock's own split", () => {
		expect(roleGroup("smol", "chat")).toBe("conversation");
		expect(roleGroup("judge", "kind")).toBe("io");
		// A built-in of a newer omp: kind roles go to input & output, the rest to agent work.
		expect(roleGroup("future-kind", "kind")).toBe("io");
		expect(roleGroup("future-chat", "chat")).toBe("agent");
	});
});
