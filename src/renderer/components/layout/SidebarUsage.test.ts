import { describe, expect, it } from "vitest";
import type { UsageLimit, UsageReport } from "../../../shared/rpc-types";
import { usageLines } from "./SidebarUsage";

const limit = (id: string, usedFraction: number | undefined, windowId?: string): UsageLimit => ({
	id,
	label: id,
	usedFraction,
	windowId,
});

const report = (provider: string, account: string, limits: UsageLimit[], active?: boolean): UsageReport => ({
	provider,
	account,
	fetchedAt: 0,
	limits,
	active,
});

const five = (provider: string) => [limit(`${provider}:5h`, 0.15, "5h"), limit(`${provider}:7d`, 0.39, "7d")];

describe("usageLines", () => {
	it("lists one line per account with usage windows, by company then account, API keys left out", () => {
		const reports = [
			report("openai-codex", "z@x.com", five("openai-codex")),
			report("anthropic", "b@x.com", five("anthropic")),
			report("openrouter", "key", []),
			report("anthropic", "a@x.com", five("anthropic")),
			report("zai", "calls", [limit("zai:calls", undefined)]),
		];
		expect(usageLines(reports, "anthropic").map(line => line.report.account)).toEqual([
			"a@x.com",
			"b@x.com",
			"z@x.com",
		]);
	});

	it("marks the account this tab uses, the active one of its provider", () => {
		const reports = [
			report("anthropic", "a@x.com", five("anthropic")),
			report("anthropic", "b@x.com", five("anthropic"), true),
			report("openai-codex", "c@x.com", five("openai-codex")),
		];
		expect(usageLines(reports, "anthropic").map(line => [line.report.account, line.inUse])).toEqual([
			["a@x.com", false],
			["b@x.com", true],
			["c@x.com", false],
		]);
		expect(usageLines(reports, null).every(line => !line.inUse)).toBe(true);
	});
});
