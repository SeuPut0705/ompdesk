import { describe, expect, it } from "vitest";
import { shownRoleValue, storedRoleValue } from "../../resources/gui-bridge/role-values";

describe("gui-bridge model-role values", () => {
	it("stores a bare advisor pick with :auto so it follows the primary's per-turn effort", () => {
		expect(storedRoleValue("advisor", "openai-codex/gpt-6.1-sol")).toBe("openai-codex/gpt-6.1-sol:auto");
		expect(shownRoleValue("advisor", "openai-codex/gpt-6.1-sol:auto")).toBe("openai-codex/gpt-6.1-sol");
	});

	it("keeps an explicit advisor level, a cleared role and every other role as picked", () => {
		expect(storedRoleValue("advisor", "openai-codex/gpt-6.1-sol:high")).toBe("openai-codex/gpt-6.1-sol:high");
		expect(shownRoleValue("advisor", "openai-codex/gpt-6.1-sol:high")).toBe("openai-codex/gpt-6.1-sol:high");
		expect(storedRoleValue("advisor", undefined)).toBeUndefined();
		expect(storedRoleValue("slow", "anthropic/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
		expect(shownRoleValue("slow", "anthropic/claude-opus-5-5:auto")).toBe("anthropic/claude-opus-5-5:auto");
	});
});
