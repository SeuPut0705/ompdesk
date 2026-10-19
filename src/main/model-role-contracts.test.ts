import { describe, expect, it } from "vitest";
import { HIDDEN_ROLE_IDS, HIDDEN_ROLES, ROLE_ORDER, roleGroup } from "../../resources/gui-bridge/model-role-contracts";

describe("role groups", () => {
	it("lists each role once and hides the memory role with its reason (ai-memory replaced stock's backends)", () => {
		expect(new Set(ROLE_ORDER).size).toBe(ROLE_ORDER.length);
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
