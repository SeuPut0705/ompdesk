import { describe, expect, it } from "vitest";
import type { MoveWhy, RerankSkip } from "../../../../resources/gui-bridge/account-rotation-core";
import type { UsageLimit } from "../../../shared/rpc-types";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";
import { limitValueText, rotationReason } from "./UsageQuotas";

function valueText(amount: Omit<UsageLimit, "id" | "label">): string {
	return limitValueText({ id: "quota", label: "Quota", ...amount }, (key, params) =>
		(ko[key] ?? key).replace("{value}", String(params?.value ?? "")),
	);
}

describe("provider quota values", () => {
	it("shows the used percentage when Core supplies an unknown quota unit", () => {
		expect(valueText({ unit: "unknown", used: 81, limit: 100, usedFraction: 0.81 })).toBe("81% 사용");
	});

	it("preserves an explicit zero fraction when a legacy report omits its unit", () => {
		expect(valueText({ used: 5, limit: 100, usedFraction: 0 })).toBe("0% 사용");
	});

	it("retains named units and percent precision when the unit is known", () => {
		expect(valueText({ unit: "percent", used: 12.2, limit: 100, usedFraction: 0.122 })).toBe("12.2% / 100%");
		expect(valueText({ unit: "requests", used: 12, limit: 100, usedFraction: 0.12 })).toBe(
			"12 requests / 100 requests",
		);
	});

	it("keeps raw counts without a unit and does not invent a percentage for missing data", () => {
		expect(valueText({ unit: "unknown", used: 5, limit: 100 })).toBe("5 / 100");
		expect(valueText({ unit: "unknown", used: 5 })).toBe("5.0 사용");
		expect(valueText({ unit: "unknown" })).toBe("알 수 없음");
	});
});

describe("the line saying why a session is on its account", () => {
	// Exhaustive by type: a code the rotation core adds fails this table until its line is decided here.
	const SHOWN: Record<Exclude<RerankSkip | MoveWhy, "single-account" | "no-pin" | "no-model">, true> = {
		better: true,
		"near-limit": true,
		"much-better": true,
		same: true,
		"within-margin": true,
		"mid-turn": true,
		"no-better": true,
		"usage-unreadable": true,
		explicit: true,
		restricted: true,
		policy: true,
		blocked: true,
		subagents: true,
		cold: true,
		"no-choice": true,
		"pin-refused": true,
		mode: true,
		"unknown-provenance": true,
	};
	const rotation = (why: string) => ({ why, moved: false, phase: "turn-start", at: 1 });

	it.each(Object.keys(SHOWN))("has an English and a Korean line for %s", why => {
		const english = rotationReason(rotation(why), (key: string) => en[key] ?? key);
		const korean = rotationReason(rotation(why), (key: string) => ko[key] ?? key);
		expect(english).toBe(en[`usage.rotation.${why}`]);
		expect(korean).toBe(ko[`usage.rotation.${why}`]);
		expect(english).not.toBe(`usage.rotation.${why}`);
	});

	it("says nothing for a session with one account, none yet, no model, or before its first decision", () => {
		for (const why of ["single-account", "no-pin", "no-model"]) {
			expect(rotationReason(rotation(why), (key: string) => key)).toBeNull();
		}
		expect(rotationReason(undefined, (key: string) => key)).toBeNull();
	});
});
