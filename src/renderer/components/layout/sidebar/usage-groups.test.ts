import { describe, expect, it } from "vitest";
import type { UsageReport } from "../../../../shared/rpc-types";
import { usageAccountGroups } from "./usage-groups";

describe("usageAccountGroups", () => {
	const windows = (provider: string) => [
		{ id: `${provider}:5h`, label: "5h", usedFraction: 0.15, windowId: "5h" },
		{ id: `${provider}:7d:fable`, label: "Claude 7 Day (Fable)", usedFraction: 0.39, windowId: "7d" },
	];
	const report = (provider: string, account: string, patch: Partial<UsageReport> = {}): UsageReport => ({
		provider,
		account,
		fetchedAt: 0,
		limits: windows(provider),
		...patch,
	});

	it("lists every account of every provider, API keys and window-less accounts left out", () => {
		const reports = [
			report("openai-codex", "z@x.com"),
			report("anthropic", "b@x.com"),
			report("openrouter", "key", { limits: [] }),
			report("anthropic", "a@x.com"),
			report("openai-codex", "y@x.com"),
		];
		const groups = usageAccountGroups(reports, null);
		expect(groups.map(group => group.provider)).toEqual(["anthropic", "openai-codex"]);
		expect(groups.map(group => group.accounts.map(entry => entry.report.account))).toEqual([
			["a@x.com", "b@x.com"],
			["y@x.com", "z@x.com"],
		]);
	});

	it("keeps a fixed order by address and marks the session's own account without moving it", () => {
		const reports = [report("anthropic", "b@x.com", { active: true }), report("anthropic", "a@x.com")];
		const [group] = usageAccountGroups(reports, "anthropic");
		expect(group?.accounts.map(entry => [entry.report.account, entry.inUse])).toEqual([
			["a@x.com", false],
			["b@x.com", true],
		]);
	});

	it("puts the provider this tab uses, or holds the session's account, first", () => {
		const reports = [report("anthropic", "a@x.com"), report("openai-codex", "c@x.com")];
		const used = usageAccountGroups(reports, "openai-codex");
		expect(used.map(group => group.provider)).toEqual(["openai-codex", "anthropic"]);
		const pinned = [report("anthropic", "a@x.com"), report("openai-codex", "c@x.com", { active: true })];
		expect(usageAccountGroups(pinned, null).map(group => [group.provider, group.inUse])).toEqual([
			["openai-codex", true],
			["anthropic", false],
		]);
	});
});
