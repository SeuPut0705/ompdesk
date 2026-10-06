/**
 * Drive a stats sync to completion. `POST /api/sync` only queues work on the
 * stats server (202 + live status), so the outcome has to be read from
 * `GET /api/status` until the queued full sync finishes.
 */

import type { LiveSyncStatus } from "../../shared/stats-types";

const SYNC_POLL_MS = 750;
/** A first-time ingest can take a while; past this the sync keeps running server-side. */
const SYNC_TIMEOUT_MS = 120_000;

export type StatsSyncOutcome =
	| { kind: "done"; processed: number; files: number }
	| { kind: "error"; message: string }
	| { kind: "unavailable"; message: string }
	| { kind: "timeout" };

export interface StatsSyncOptions {
	pollMs?: number;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** The stats:fetch bridge resolves failures as `{ error, unavailable }` instead of rejecting. */
function bridgeFailure(reply: unknown): StatsSyncOutcome | null {
	if (!reply || typeof reply !== "object" || !("error" in reply)) return null;
	const { error, unavailable } = reply as { error?: unknown; unavailable?: unknown };
	const message = typeof error === "string" ? error : "";
	return unavailable === true ? { kind: "unavailable", message } : { kind: "error", message };
}

function liveSync(reply: unknown): LiveSyncStatus | null {
	if (!reply || typeof reply !== "object" || !("sync" in reply)) return null;
	const sync = (reply as { sync?: unknown }).sync;
	return sync && typeof sync === "object" && "phase" in sync ? (sync as LiveSyncStatus) : null;
}

export async function runStatsSync(
	fetchStats: (path: string) => Promise<unknown>,
	options: StatsSyncOptions = {},
): Promise<StatsSyncOutcome> {
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const deadline = now() + (options.timeoutMs ?? SYNC_TIMEOUT_MS);

	const queued = await fetchStats("/api/sync");
	const queueFailure = bridgeFailure(queued);
	if (queueFailure) return queueFailure;
	let status = liveSync(queued);
	if (!status) return { kind: "error", message: "Unexpected /api/sync reply" };
	// Completion = a sync finished after the request: a quiet per-file sync that
	// was already running can report `idle` before the queued full sync starts.
	const baseline = status.lastSyncedAt;

	for (;;) {
		if (status.phase === "error") return { kind: "error", message: status.error ?? "" };
		if (status.phase === "idle" && status.lastSyncedAt !== baseline) {
			return { kind: "done", processed: status.processed, files: status.total };
		}
		if (now() >= deadline) return { kind: "timeout" };
		await sleep(options.pollMs ?? SYNC_POLL_MS);
		const reply = await fetchStats("/api/status");
		const pollFailure = bridgeFailure(reply);
		if (pollFailure) return pollFailure;
		const next = liveSync(reply);
		if (!next) return { kind: "error", message: "Unexpected /api/status reply" };
		status = next;
	}
}
