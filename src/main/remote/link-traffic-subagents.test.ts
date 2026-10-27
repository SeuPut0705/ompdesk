/**
 * Four subagents of one task call streaming over the link, in wire bytes (frame header, encryption and deflate
 * included: what the host's `traffic` line counts). `OMP_GUI_LINK_TRAFFIC=1 bunx vitest run
 * src/main/remote/link-traffic-subagents.test.ts` prints bytes a minute for each device build in
 * `OMP_GUI_LINK_TRAFFIC_DEVICES` (comma separated, default `current`), `OMP_GUI_LINK_TRAFFIC_RUNS` runs each (default
 * 5), interleaved, `OMP_GUI_LINK_TRAFFIC_SECONDS` of work a run (default 20) and subscription
 * `OMP_GUI_LINK_TRAFFIC_LEVEL` (default `progress`, what every tab asks; `events` is the work map open).
 */
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, it, vi } from "vitest";
import { closeSessions, type DeviceKind, openSession } from "./link-traffic-test-rig";
import { Link, type TrafficHandler } from "./wire";

const MEASURE = process.env.OMP_GUI_LINK_TRAFFIC === "1";

afterEach(async () => {
	vi.restoreAllMocks();
	await closeSessions();
});

interface Wire {
	tx: number;
	frames: number;
	kinds: Map<string, { frames: number; bytes: number }>;
}

/** Counts what each host link sends, as its traffic line would. */
function countHostWire(): Wire {
	const wire: Wire = { tx: 0, frames: 0, kinds: new Map() };
	const original = Link.prototype.onTraffic;
	vi.spyOn(Link.prototype, "onTraffic").mockImplementation(function (this: Link, handler: TrafficHandler) {
		original.call(this, (direction, message, bytes) => {
			if (direction === "tx") {
				const { t, event, data } = message as { t: string; event?: string; data?: { name?: string } };
				const kind = t === "evt" ? `${event} ${data?.name ?? ""}` : t;
				const row = wire.kinds.get(kind) ?? { frames: 0, bytes: 0 };
				row.frames++;
				row.bytes += bytes;
				wire.kinds.set(kind, row);
				wire.tx += bytes;
				wire.frames++;
			}
			handler(direction, message, bytes);
		});
	});
	return wire;
}

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

describe.skipIf(!MEASURE)("four subagents over the link", () => {
	const devices = (process.env.OMP_GUI_LINK_TRAFFIC_DEVICES ?? "current").split(",") as DeviceKind[];
	const runs = Number(process.env.OMP_GUI_LINK_TRAFFIC_RUNS) || 5;
	const seconds = Number(process.env.OMP_GUI_LINK_TRAFFIC_SECONDS) || 20;
	const level = (process.env.OMP_GUI_LINK_TRAFFIC_LEVEL ?? "progress") as "off" | "progress" | "events";

	it("bytes a minute by device build", async () => {
		const perMinute = new Map<DeviceKind, number[]>(devices.map(device => [device, []]));
		const lastKinds = new Map<DeviceKind, Wire["kinds"]>();
		for (let run = 0; run < runs; run++) {
			for (const device of devices) {
				const wire = countHostWire();
				const session = await openSession({ device });
				await session.setLevel(level);
				// The level command's answer is in; its effect on the omp is not observable here, so let it land.
				await delay(300);
				wire.tx = 0;
				wire.frames = 0;
				wire.kinds.clear();
				const started = Date.now();
				await session.turn({ kind: "subagents", count: 4, seconds, textTokens: 120, tokenMs: 12 });
				const ms = Date.now() - started;
				perMinute.get(device)?.push((wire.tx / ms) * 60_000);
				lastKinds.set(device, new Map(wire.kinds));
				console.log(`run ${run} ${device}: ${(wire.tx / 1000).toFixed(0)} KB in ${ms} ms, ${wire.frames} frames`);
				vi.restoreAllMocks();
				await closeSessions();
			}
		}
		for (const [device, values] of perMinute) {
			const kinds = [...(lastKinds.get(device) ?? new Map())]
				.sort((a, b) => b[1].bytes - a[1].bytes)
				.slice(0, 6)
				.map(([kind, row]) => `${kind} ${row.frames} fr ${(row.bytes / 1000).toFixed(0)} KB`)
				.join("; ");
			console.log(
				`${device} (${level}): median ${(median(values) / 1000).toFixed(0)} KB/min, range ${(Math.min(...values) / 1000).toFixed(0)}-${(Math.max(...values) / 1000).toFixed(0)} KB/min over ${values.length} runs\n  last run: ${kinds}`,
			);
		}
	}, 600_000);
});
