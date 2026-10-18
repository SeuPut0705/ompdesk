/**
 * Main-thread hang watchdog, pure rules (observation only: nothing here, and nothing
 * the worker does with it, ever kills or restarts main).
 *
 * Main posts a heartbeat to a worker thread every `HANG_HEARTBEAT_INTERVAL_MS`; the
 * worker ticks on its own timer and reports a hang once no heartbeat arrived for
 * longer than `HANG_TIMEOUT_MS`. The worker writes a marker file, rewritten when the
 * heartbeats resume (`selfRecovered`), and the next launch reports it in
 * `gui-runtime.jsonl` (`source: "main-thread-hang"`). The idea (worker plus heartbeat,
 * tick-gap sleep detection, marker consumed on the next launch) is Orca's
 * `src/main/hang-watchdog/`, reimplemented.
 */
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

export const HANG_HEARTBEAT_INTERVAL_MS = 1_000;
export const HANG_CHECK_INTERVAL_MS = 1_000;
export const HANG_TIMEOUT_MS = 5_000;
/** A worker tick later than this many check intervals means the process was suspended, not that main hung. */
export const SLEEP_GAP_FACTOR = 3;
const MAX_MARKER_BYTES = 64 * 1024;

export interface HangDetectionConfig {
	timeoutMs: number;
	checkIntervalMs: number;
	now: () => number;
	onHang: (unresponsiveMs: number) => void;
	/** Heartbeats came back after a reported hang: main was stalled, not deadlocked. */
	onResolved: (unresponsiveMs: number) => void;
}

export interface HangDetector {
	heartbeat(): void;
	tick(): void;
	/** The OS resumed from suspend: wait for fresh heartbeats before judging main. */
	reset(): void;
}

export function createHangDetector(config: HangDetectionConfig): HangDetector {
	let lastHeartbeatAt = config.now();
	let lastTickAt = lastHeartbeatAt;
	let reported = false;
	return {
		heartbeat() {
			const now = config.now();
			if (reported) {
				reported = false;
				config.onResolved(now - lastHeartbeatAt);
			}
			lastHeartbeatAt = now;
		},
		tick() {
			const now = config.now();
			const gap = now - lastTickAt;
			// Kept moving while a hang is outstanding, or the first tick after it clears would read as a sleep.
			lastTickAt = now;
			if (reported) return;
			if (gap > config.checkIntervalMs * SLEEP_GAP_FACTOR) {
				// This worker was suspended too (system sleep): start the wait over.
				lastHeartbeatAt = now;
				return;
			}
			const unresponsiveMs = now - lastHeartbeatAt;
			if (unresponsiveMs > config.timeoutMs) {
				reported = true;
				config.onHang(unresponsiveMs);
			}
		},
		reset() {
			const now = config.now();
			lastHeartbeatAt = now;
			lastTickAt = now;
		},
	};
}

export interface HangMarker {
	detectedAt: number;
	pid: number;
	unresponsiveMs: number;
	/** False for a marker the stall never cleared (a deadlock, or the app was killed during it). */
	selfRecovered: boolean;
}

export type MainToHangWorkerMessage = { type: "heartbeat" } | { type: "resume" } | { type: "shutdown" };

export interface HangWorkerData {
	pid: number;
	markerPath: string;
	timeoutMs: number;
	checkIntervalMs: number;
}

export function writeHangMarker(markerPath: string, marker: HangMarker): void {
	writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
}

function parseMarker(raw: string): HangMarker | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const { detectedAt, pid, unresponsiveMs, selfRecovered } = value as Record<string, unknown>;
	if (typeof detectedAt !== "number" || !Number.isFinite(detectedAt)) return null;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof unresponsiveMs !== "number" || !Number.isFinite(unresponsiveMs) || unresponsiveMs < 0) return null;
	return { detectedAt, pid, unresponsiveMs, selfRecovered: selfRecovered === true };
}

/** Reads and removes the previous run's marker; null when there is none or it is unreadable. */
export function consumeHangMarker(markerPath: string): HangMarker | null {
	let marker: HangMarker | null = null;
	try {
		if (statSync(markerPath).size <= MAX_MARKER_BYTES) marker = parseMarker(readFileSync(markerPath, "utf8"));
	} catch {
		return null;
	}
	try {
		rmSync(markerPath, { force: true });
	} catch {
		// A marker that cannot be removed may be reported twice; it never blocks launch.
	}
	return marker;
}
