/**
 * Worker thread of the main-thread hang watchdog (built as its own entry,
 * `out/main/hang-watchdog-worker.js`; see `hang-watchdog.ts`). It only watches:
 * a stall is written to the marker file and nothing else happens.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
	createHangDetector,
	type HangWorkerData,
	type MainToHangWorkerMessage,
	writeHangMarker,
} from "./hang-watchdog-core";

function isWorkerData(value: unknown): value is HangWorkerData {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Partial<HangWorkerData>;
	return (
		typeof data.pid === "number" &&
		typeof data.markerPath === "string" &&
		typeof data.timeoutMs === "number" &&
		data.timeoutMs > 0 &&
		typeof data.checkIntervalMs === "number" &&
		data.checkIntervalMs > 0
	);
}

if (!isMainThread && parentPort && isWorkerData(workerData)) {
	const config = workerData;
	const port = parentPort;
	const record = (unresponsiveMs: number, selfRecovered: boolean): void => {
		try {
			writeHangMarker(config.markerPath, {
				detectedAt: Date.now(),
				pid: config.pid,
				unresponsiveMs,
				selfRecovered,
			});
		} catch {
			// Best effort: a marker that cannot be written must not stop the watchdog.
		}
	};
	const detector = createHangDetector({
		timeoutMs: config.timeoutMs,
		checkIntervalMs: config.checkIntervalMs,
		now: () => Date.now(),
		onHang: ms => record(ms, false),
		// Rewriting the marker keeps one record per stall.
		onResolved: ms => record(ms, true),
	});
	const timer = setInterval(() => detector.tick(), config.checkIntervalMs);
	port.on("message", (message: MainToHangWorkerMessage) => {
		if (message.type === "heartbeat") detector.heartbeat();
		else if (message.type === "resume") detector.reset();
		else {
			clearInterval(timer);
			port.close();
		}
	});
}
