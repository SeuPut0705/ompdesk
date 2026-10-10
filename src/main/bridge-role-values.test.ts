import { describe, expect, it } from "vitest";
import { shownRoleValue, storedRoleValue } from "../../resources/gui-bridge/role-values";

describe("advisor auto policy around stock selector", () => {
	it("appends auto when stock says there is no explicit thinking selector", () => {
		expect(storedRoleValue("advisor", "provider/model", () => undefined)).toBe("provider/model:auto");
		expect(storedRoleValue("advisor", "provider/literal:max", () => undefined)).toBe("provider/literal:max:auto");
		expect(shownRoleValue("advisor", "provider/model:auto")).toBe("provider/model");
	});
	it("preserves stock explicit selectors, clears, and other roles", () => {
		expect(storedRoleValue("advisor", "provider/model:high", () => "high")).toBe("provider/model:high");
		expect(storedRoleValue("advisor", undefined, () => undefined)).toBeUndefined();
		expect(storedRoleValue("slow", "provider/model", () => undefined)).toBe("provider/model");
		expect(shownRoleValue("slow", "provider/model:auto")).toBe("provider/model:auto");
	});
});
