import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentWorktreeAutoClean,
	AUTO_CLEAN_FIRST_DELAY_MS,
	AUTO_CLEAN_INTERVAL_MS,
	clearAgentWorktrees,
	listAgentWorktrees,
	parseAgentWorktreeClear,
	parseAgentWorktrees,
} from "./agent-worktrees";
import type { OmpRuntime } from "./local/types";
import { resolveOmp } from "./omp-runtime";

type Run = OmpRuntime["run"];

function fakeOmp(run: Run): OmpRuntime {
	return { bin: "omp", version: "18.8.7", run };
}

const CLEAR_REPORT = JSON.stringify({
	removed: 1,
	failed: 1,
	results: [
		{ path: "/home/u/.omp/wt/a", ok: true },
		{ path: "/home/u/.omp/wt/b", ok: false, error: "EBUSY" },
	],
});

afterEach(() => {
	vi.useRealTimers();
});

describe("parseAgentWorktrees", () => {
	it("reads stock's WorktreeEntry[] and drops rows of another shape", () => {
		const stdout = JSON.stringify([
			{ path: "/w/pr", kind: "pr-checkout", parentRepo: "/repo", branch: "pr-12" },
			{ path: "/w/task", kind: "task-isolation", orphanReason: "owner process is gone" },
			{ path: "/w/x", kind: "unknown-kind" },
			{ kind: "stray" },
			"noise",
		]);
		expect(parseAgentWorktrees(stdout)).toEqual([
			{ path: "/w/pr", kind: "pr-checkout", parentRepo: "/repo", branch: "pr-12" },
			{ path: "/w/task", kind: "task-isolation", orphanReason: "owner process is gone" },
		]);
		expect(parseAgentWorktrees("[]")).toEqual([]);
		expect(parseAgentWorktrees("not json")).toBeNull();
		expect(parseAgentWorktrees("{}")).toBeNull();
	});
});

describe("parseAgentWorktreeClear", () => {
	it("reads both of stock's clear reports", () => {
		expect(parseAgentWorktreeClear(CLEAR_REPORT)).toEqual({
			removed: 1,
			failed: 1,
			results: [
				{ path: "/home/u/.omp/wt/a", ok: true },
				{ path: "/home/u/.omp/wt/b", ok: false, error: "EBUSY" },
			],
		});
		// Nothing orphaned: stock prints `{removed: 0, kept}`.
		expect(parseAgentWorktreeClear(JSON.stringify({ removed: 0, kept: 3 }))).toEqual({
			removed: 0,
			failed: 0,
			results: [],
		});
		expect(parseAgentWorktreeClear("[]")).toBeNull();
		expect(parseAgentWorktreeClear("oops")).toBeNull();
	});
});

describe("list / clear", () => {
	it("runs stock's JSON commands, never --all, and reports omp's own failure text", async () => {
		const calls: string[][] = [];
		const omp = fakeOmp(async args => {
			calls.push(args);
			if (args[1] === "list") return { code: 0, stdout: "[]", stderr: "" };
			return { code: 0, stdout: CLEAR_REPORT, stderr: "" };
		});
		await expect(listAgentWorktrees(omp)).resolves.toEqual([]);
		await expect(clearAgentWorktrees(omp)).resolves.toMatchObject({ removed: 1, failed: 1 });
		expect(calls).toEqual([
			["worktree", "list", "--json"],
			["worktree", "clear", "--json"],
		]);

		const broken = fakeOmp(async () => ({ code: 2, stdout: "", stderr: "line 1\nUnknown command: worktree" }));
		await expect(listAgentWorktrees(broken)).rejects.toThrow("Unknown command: worktree");
	});
});

describe("AgentWorktreeAutoClean", () => {
	function harness(enabled: { value: boolean }) {
		const runs: string[][] = [];
		const log: string[] = [];
		const cleaner = new AgentWorktreeAutoClean({
			enabled: () => enabled.value,
			omp: async () =>
				fakeOmp(async args => {
					runs.push(args);
					return { code: 0, stdout: CLEAR_REPORT, stderr: "" };
				}),
			log: message => log.push(message),
		});
		return { cleaner, runs, log };
	}

	it("clears a minute after launch, then every 6 hours, while the pref is on", async () => {
		vi.useFakeTimers();
		const enabled = { value: true };
		const { cleaner, runs, log } = harness(enabled);
		cleaner.start();
		await vi.advanceTimersByTimeAsync(AUTO_CLEAN_FIRST_DELAY_MS - 1);
		expect(runs).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(runs).toEqual([["worktree", "clear", "--json"]]);
		expect(log).toEqual(["worktree auto-clean: 1 removed, 1 failed"]);
		await vi.advanceTimersByTimeAsync(AUTO_CLEAN_INTERVAL_MS);
		expect(runs).toHaveLength(2);

		// Off: no further runs.
		enabled.value = false;
		cleaner.prefChanged();
		await vi.advanceTimersByTimeAsync(AUTO_CLEAN_INTERVAL_MS * 2);
		expect(runs).toHaveLength(2);
		cleaner.stop();
	});

	it("does nothing while the pref is off and cleans at once when it is switched on", async () => {
		vi.useFakeTimers();
		const enabled = { value: false };
		const { cleaner, runs } = harness(enabled);
		cleaner.start();
		await vi.advanceTimersByTimeAsync(AUTO_CLEAN_FIRST_DELAY_MS * 2);
		expect(runs).toHaveLength(0);
		enabled.value = true;
		cleaner.prefChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(runs).toHaveLength(1);
		cleaner.stop();
	});

	it("logs a failed run and keeps going", async () => {
		const log: string[] = [];
		const cleaner = new AgentWorktreeAutoClean({
			enabled: () => true,
			omp: async () => fakeOmp(async () => ({ code: 1, stdout: "", stderr: "boom" })),
			log: message => log.push(message),
		});
		await cleaner.runOnce();
		expect(log).toEqual(["worktree auto-clean failed: boom"]);
	});
});

describe("stock omp worktree list --json", () => {
	it("parses the installed omp's own output", async () => {
		const omp = await resolveOmp();
		if (!omp.ok) return;
		const entries = await listAgentWorktrees(omp.runtime);
		expect(Array.isArray(entries)).toBe(true);
	});
});
