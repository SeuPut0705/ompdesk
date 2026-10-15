import { describe, expect, it } from "vitest";
import type { UsageLimit, UsageReport } from "../../../shared/rpc-types";
import { railLimits } from "./SidebarUsage";

const limit = (id: string, usedFraction: number | undefined, windowId?: string): UsageLimit => ({
	id,
	label: id,
	usedFraction,
	windowId,
});

const report = (provider: string, limits: UsageLimit[], active?: boolean): UsageReport => ({
	provider,
	fetchedAt: 0,
	limits,
	active,
});

describe("railLimits", () => {
	it("takes the 5-hour and weekly windows of the account in use for the tab's provider", () => {
		const reports = [
			report("openai", [limit("openai:5h", 0.9, "5h")]),
			report("anthropic", [limit("anthropic:5h", 0.1, "5h"), limit("anthropic:7d", 0.2, "7d")]),
			report(
				"anthropic",
				[
					limit("anthropic:7d:opus", 0.95, "7d"),
					limit("anthropic:7d", 0.6, "7d"),
					limit("anthropic:5h", 0.4, "5h"),
				],
				true,
			),
		];
		expect(railLimits(reports, "anthropic").map(entry => [entry.id, entry.usedFraction])).toEqual([
			["anthropic:5h", 0.4],
			["anthropic:7d", 0.6],
		]);
	});

	it("falls back to the two fullest measured limits, and to nothing for another provider", () => {
		const reports = [
			report("zai", [
				limit("zai:tokens", 0.3, "monthly"),
				limit("zai:calls", 0.8, "daily"),
				limit("zai:unknown", undefined),
				limit("zai:mcp", 0.5, "monthly"),
			]),
		];
		expect(railLimits(reports, "zai").map(entry => entry.id)).toEqual(["zai:calls", "zai:mcp"]);
		expect(railLimits(reports, "anthropic")).toEqual([]);
		expect(railLimits(reports, null)).toEqual([]);
	});
});
