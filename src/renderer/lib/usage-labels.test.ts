import { describe, expect, it } from "vitest";
import { en } from "../locales/en";
import { ko } from "../locales/ko";
import { usageLimitLabel } from "./usage-labels";

const translator =
	(table: Record<string, string>) =>
	(key: string, params?: Record<string, string | number>): string =>
		(table[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""));

const tKo = translator(ko);
const tEn = translator(en);

describe("usageLimitLabel", () => {
	// Stock's limits as pi-ai builds them (usage/claude.ts, usage/openai-codex.ts).
	const claude5h = { id: "anthropic:5h", label: "Claude 5 Hour", windowId: "5h", windowLabel: "5 Hour" };
	const claude7d = { id: "anthropic:7d", label: "Claude 7 Day", windowId: "7d", windowLabel: "7 Day" };
	const codexPrimary = { id: "openai-codex:primary", label: "5 Hour", windowId: "5h", windowLabel: "5 Hour" };
	const codexSpark = {
		id: "openai-codex:spark:secondary",
		label: "7 Day (Spark)",
		windowId: "7d",
		windowLabel: "7 Day",
	};

	it("names stock's limits in the UI language", () => {
		expect(usageLimitLabel(claude5h, tKo)).toBe("5시간 한도");
		expect(usageLimitLabel(claude7d, tKo)).toBe("주간 한도");
		expect(usageLimitLabel(codexPrimary, tKo)).toBe("5시간 한도");
		expect(usageLimitLabel(codexSpark, tKo)).toBe("주간 한도 (Spark)");
		expect(
			usageLimitLabel({ ...codexPrimary, id: "x:3d", label: "3 Day", windowId: "3d", windowLabel: "3 Day" }, tKo),
		).toBe("3일 한도");
		expect(usageLimitLabel(claude5h, tEn)).toBe("5-hour limit");
		expect(usageLimitLabel(claude7d, tEn)).toBe("Weekly limit");
	});

	it("keeps stock's label when the window cannot name the limit", () => {
		const credits = { id: "alibaba:5h", label: "5 Hour Credits", windowId: "5h", windowLabel: "5 Hour" };
		expect(usageLimitLabel(credits, tKo)).toBe("5 Hour Credits");
		expect(usageLimitLabel({ id: "x:quota", label: "Requests" }, tKo)).toBe("Requests");
		expect(
			usageLimitLabel({ id: "x:tick", label: "rolling 5h", windowId: "custom", windowLabel: "rolling 5h" }, tKo),
		).toBe("rolling 5h");
	});
});
