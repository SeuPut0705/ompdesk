import { describe, expect, it } from "vitest";
import type { UsageLimit } from "../../../shared/rpc-types";
import { zh } from "../../locales/zh";
import { limitValueText } from "./UsageWindow";

function valueText(amount: Omit<UsageLimit, "id" | "label">): string {
	return limitValueText({ id: "quota", label: "Quota", ...amount }, (key, params) =>
		(zh[key] ?? key).replace("{value}", String(params?.value ?? "")),
	);
}

describe("provider quota values", () => {
	it("shows the used percentage when Core supplies an unknown quota unit", () => {
		expect(valueText({ unit: "unknown", used: 81, limit: 100, usedFraction: 0.81 })).toBe("已用 81%");
	});

	it("preserves an explicit zero fraction when a legacy report omits its unit", () => {
		expect(valueText({ used: 5, limit: 100, usedFraction: 0 })).toBe("已用 0%");
	});

	it("retains named units and percent precision when the unit is known", () => {
		expect(valueText({ unit: "percent", used: 12.2, limit: 100, usedFraction: 0.122 })).toBe("12.2% / 100%");
		expect(valueText({ unit: "requests", used: 12, limit: 100, usedFraction: 0.12 })).toBe(
			"12 requests / 100 requests",
		);
	});

	it("keeps raw counts without a unit and does not invent a percentage for missing data", () => {
		expect(valueText({ unit: "unknown", used: 5, limit: 100 })).toBe("5 / 100");
		expect(valueText({ unit: "unknown", used: 5 })).toBe("已用 5.0");
		expect(valueText({ unit: "unknown" })).toBe("未知");
	});
});
