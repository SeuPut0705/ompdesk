import { describe, expect, it } from "vitest";
import { runStatsSync } from "./stats-sync";

function status(phase: "idle" | "syncing" | "error", extra: Record<string, unknown> = {}) {
	return {
		version: 1,
		sync: { phase, current: 0, total: 0, processed: 0, lastSyncedAt: null, error: null, ...extra },
		indexingHours: 0,
	};
}

/** Replies to /api/sync with `queued`, then serves `polls` in order to /api/status. */
function server(queued: unknown, polls: unknown[]) {
	const calls: string[] = [];
	const fetchStats = async (path: string) => {
		calls.push(path);
		return path === "/api/sync" ? queued : polls.shift();
	};
	return { calls, fetchStats };
}

const instant = { sleep: async () => {} };

describe("runStatsSync", () => {
	it("waits for the queued sync to finish and reports its real counts", async () => {
		const { calls, fetchStats } = server(status("syncing", { lastSyncedAt: 100 }), [
			status("syncing", { current: 400, total: 1038, lastSyncedAt: 100 }),
			status("idle", { current: 1038, total: 1038, processed: 98358, lastSyncedAt: 200 }),
		]);
		expect(await runStatsSync(fetchStats, instant)).toEqual({ kind: "done", processed: 98358, files: 1038 });
		expect(calls).toEqual(["/api/sync", "/api/status", "/api/status"]);
	});

	it("does not mistake a stale idle status for the finished sync", async () => {
		// A quiet per-file sync was running when the request landed: idle, old timestamp.
		const { fetchStats } = server(status("idle", { lastSyncedAt: 100 }), [
			status("idle", { lastSyncedAt: 100 }),
			status("syncing", { lastSyncedAt: 100 }),
			status("idle", { total: 3, processed: 7, lastSyncedAt: 300 }),
		]);
		expect(await runStatsSync(fetchStats, instant)).toEqual({ kind: "done", processed: 7, files: 3 });
	});

	it("surfaces a failed sync", async () => {
		const { fetchStats } = server(status("syncing"), [status("error", { error: "database is locked" })]);
		expect(await runStatsSync(fetchStats, instant)).toEqual({ kind: "error", message: "database is locked" });
	});

	it("passes bridge failures through, distinguishing a booting server", async () => {
		const booting = server({ error: "not ready", unavailable: true }, []);
		expect(await runStatsSync(booting.fetchStats, instant)).toEqual({ kind: "unavailable", message: "not ready" });
		const broken = server({ error: "Stats API error: 500", unavailable: false }, []);
		expect(await runStatsSync(broken.fetchStats, instant)).toEqual({
			kind: "error",
			message: "Stats API error: 500",
		});
	});

	it("gives up waiting after the timeout while the sync keeps running", async () => {
		let clock = 0;
		const { fetchStats } = server(
			status("syncing"),
			Array.from({ length: 10 }, () => status("syncing")),
		);
		const outcome = await runStatsSync(fetchStats, {
			timeoutMs: 3000,
			pollMs: 1000,
			now: () => clock,
			sleep: async ms => {
				clock += ms;
			},
		});
		expect(outcome).toEqual({ kind: "timeout" });
	});
});
