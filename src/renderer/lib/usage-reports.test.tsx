import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { UsageReport } from "../../shared/rpc-types";
import {
	inUseReport,
	lastUsedAccounts,
	readUsageReports,
	USAGE_BACKOFF_MAX_MS,
	USAGE_POLL_MS,
	usagePollDelay,
	useUsageSignal,
	watchUsage,
} from "./usage-reports";

const { document, window, Event } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;

let read: Mock<() => Promise<boolean>>;
let stop: (() => void) | undefined;

function watch(): void {
	stop = watchUsage(() => read());
}

/** Advances the fake clock and lets the reads it starts settle. */
async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

function setVisibility(state: "visible" | "hidden"): void {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

beforeEach(() => {
	vi.useFakeTimers();
	read = vi.fn(async () => true);
	setVisibility("visible");
});

afterEach(() => {
	stop?.();
	stop = undefined;
	vi.useRealTimers();
	useUsageSignal.getState().reset();
});

describe("usagePollDelay", () => {
	it("polls every 30 s and doubles the wait per failed read up to 5 minutes", () => {
		expect([0, 1, 2, 3, 4, 9].map(usagePollDelay)).toEqual([
			30_000,
			60_000,
			120_000,
			240_000,
			USAGE_BACKOFF_MAX_MS,
			USAGE_BACKOFF_MAX_MS,
		]);
	});
});

describe("readUsageReports", () => {
	it("reads the reports of a success, none when it carries no array, and the error of a failure", () => {
		const report: UsageReport = { provider: "anthropic", fetchedAt: 0, limits: [] };
		expect(
			readUsageReports({ type: "response", command: "get_usage", success: true, data: { reports: [report] } }),
		).toEqual({ ok: true, reports: [report] });
		expect(readUsageReports({ type: "response", command: "get_usage", success: true, data: {} })).toEqual({
			ok: true,
			reports: [],
		});
		expect(readUsageReports({ type: "response", command: "get_usage", success: false, error: "gone" })).toEqual({
			ok: false,
			error: "gone",
		});
	});
});

describe("watchUsage", () => {
	it("re-reads every poll interval and stops when stopped", async () => {
		watch();
		expect(read).not.toHaveBeenCalled();
		await advance(USAGE_POLL_MS - 1);
		expect(read).not.toHaveBeenCalled();
		await advance(1);
		expect(read).toHaveBeenCalledTimes(1);
		await advance(USAGE_POLL_MS);
		expect(read).toHaveBeenCalledTimes(2);
		stop?.();
		await advance(USAGE_POLL_MS * 3);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("re-reads at once when any tab's turn ends and when the window regains focus", async () => {
		watch();
		useUsageSignal.getState().turnEnded();
		await advance(0);
		expect(read).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new Event("focus"));
		await advance(0);
		expect(read).toHaveBeenCalledTimes(2);
		// Each read restarts the interval.
		await advance(USAGE_POLL_MS - 1);
		expect(read).toHaveBeenCalledTimes(2);
		await advance(1);
		expect(read).toHaveBeenCalledTimes(3);
	});

	it("skips polls while the window is hidden and reads when it comes back into view", async () => {
		watch();
		setVisibility("hidden");
		await advance(USAGE_POLL_MS * 3);
		expect(read).not.toHaveBeenCalled();
		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		await advance(0);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("backs off after failed reads, ignores turn ends meanwhile, and resumes the interval after a success", async () => {
		read.mockResolvedValue(false);
		watch();
		await advance(USAGE_POLL_MS);
		expect(read).toHaveBeenCalledTimes(1);
		// One failure: the next poll waits twice as long, and a turn end does not jump it.
		useUsageSignal.getState().turnEnded();
		await advance(USAGE_POLL_MS * 2 - 1);
		expect(read).toHaveBeenCalledTimes(1);
		await advance(1);
		expect(read).toHaveBeenCalledTimes(2);
		// Two failures: four intervals; a thrown read counts as a failure too.
		read.mockRejectedValueOnce(new Error("bridge gone"));
		await advance(USAGE_POLL_MS * 4);
		expect(read).toHaveBeenCalledTimes(3);
		read.mockResolvedValue(true);
		await advance(USAGE_POLL_MS * 8);
		expect(read).toHaveBeenCalledTimes(4);
		await advance(USAGE_POLL_MS);
		expect(read).toHaveBeenCalledTimes(5);
	});

	it("never overlaps reads: a nudge while one is in flight waits for it", async () => {
		let finish: (ok: boolean) => void = () => undefined;
		read.mockImplementation(() => new Promise<boolean>(resolve => (finish = resolve)));
		watch();
		await advance(USAGE_POLL_MS);
		useUsageSignal.getState().turnEnded();
		await advance(0);
		expect(read).toHaveBeenCalledTimes(1);
		finish(true);
		await advance(USAGE_POLL_MS);
		expect(read).toHaveBeenCalledTimes(2);
	});
});

describe("inUseReport", () => {
	const limit = { id: "anthropic:5h", label: "Claude 5 Hour", usedFraction: 0.4 };
	const report = (credentialId: number, active?: boolean): UsageReport => ({
		provider: "anthropic",
		fetchedAt: 0,
		credentialId,
		limits: [limit],
		...(active ? { active } : {}),
	});

	it("is the session's account, else the first one with limits", () => {
		expect(inUseReport([report(1), report(2, true), report(3)], "anthropic")?.credentialId).toBe(2);
		expect(inUseReport([{ ...report(1), limits: [] }, report(3)], "anthropic")?.credentialId).toBe(3);
		expect(inUseReport([report(1)], "openai-codex")).toBeUndefined();
	});
});

describe("lastUsedAccounts", () => {
	const five = (provider: string) => [
		{ id: `${provider}:5h`, label: "5h", usedFraction: 0.15, windowId: "5h" },
		{ id: `${provider}:7d`, label: "7d", usedFraction: 0.39, windowId: "7d" },
	];
	const report = (provider: string, account: string, patch: Partial<UsageReport> = {}): UsageReport => ({
		provider,
		account,
		fetchedAt: 0,
		limits: five(provider),
		...patch,
	});

	it("lists one entry per provider company, API keys and window-less accounts left out", () => {
		const reports = [
			report("openai-codex", "z@x.com"),
			report("anthropic", "b@x.com"),
			report("openrouter", "key", { limits: [] }),
			report("anthropic", "a@x.com"),
			report("zai", "calls", { limits: [{ id: "zai:calls", label: "calls" }] }),
		];
		expect(lastUsedAccounts(reports, null).map(entry => entry.report.provider)).toEqual([
			"anthropic",
			"openai-codex",
		]);
	});

	it("shows the account used last: the session's pin, else the latest lastUsedAt, else the first by account", () => {
		const pinned = [
			report("anthropic", "a@x.com", { lastUsedAt: 900 }),
			report("anthropic", "b@x.com", { active: true, lastUsedAt: 100 }),
		];
		expect(lastUsedAccounts(pinned, "anthropic")[0]?.report.account).toBe("b@x.com");
		const stamped = [
			report("openai-codex", "a@x.com", { lastUsedAt: 100 }),
			report("openai-codex", "b@x.com", { lastUsedAt: 300 }),
			report("openai-codex", "c@x.com"),
		];
		expect(lastUsedAccounts(stamped, null)[0]?.report.account).toBe("b@x.com");
		const unknown = [report("openai-codex", "z@x.com"), report("openai-codex", "a@x.com")];
		expect(lastUsedAccounts(unknown, null)[0]?.report.account).toBe("a@x.com");
	});

	it("puts the provider this tab uses first and marks only it", () => {
		const reports = [report("anthropic", "a@x.com"), report("openai-codex", "c@x.com")];
		expect(lastUsedAccounts(reports, "openai-codex").map(entry => [entry.report.provider, entry.inUse])).toEqual([
			["openai-codex", true],
			["anthropic", false],
		]);
		expect(lastUsedAccounts(reports, null).every(entry => !entry.inUse)).toBe(true);
	});
});
