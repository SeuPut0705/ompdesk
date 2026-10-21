/**
 * Test-only: ports for a remote host under test (unit tests and the two-app e2e harness), free of vitest so the
 * Playwright side can import it.
 */
import { createServer, type Server } from "node:net";
import { REMOTE_PORT_SPAN } from "./address";

/** First port of the bands, below every OS's ephemeral range (macOS and Windows 49152-65535, Linux 32768-60999). */
const FIRST_PORT = 20_000;
const BAND_PORTS = 500;
const BANDS_PER_RUNNER = 12;

/** Offset in its band where each band's next run starts: a band is walked in order, never at random. */
const cursors = new Map<number, number>();

/**
 * The band of ports this worker process picks from, one per parallel worker of Playwright (`TEST_PARALLEL_INDEX`)
 * or of Vitest (`VITEST_POOL_ID`), so no two workers of a run ever pick runs that touch. Beyond
 * `BANDS_PER_RUNNER` workers the bands repeat (a bind check below still skips a run that is listening).
 */
function band(): number {
	const playwright = process.env.TEST_PARALLEL_INDEX;
	const index = Number(playwright ?? process.env.VITEST_POOL_ID ?? 0) || 0;
	const runner = playwright === undefined ? 1 : 0;
	return FIRST_PORT + (runner * BANDS_PER_RUNNER + (index % BANDS_PER_RUNNER)) * BAND_PORTS;
}

/**
 * Lowest port of a run of `count` ports free on 127.0.0.1 right now, from this worker's band. WHY: a host takes its
 * first free candidate and a device takes the first candidate that answers, so the run must hold nothing but the
 * test's own, and a run picked is not yet listened on: the test launches its app seconds later. Two picks whose
 * runs touch in that gap send a device to the other test's host, and the second device to reach it gets
 * `remote_key_mismatch` from `connect` (the host pinned the first, per node). Random picks from one shared range
 * touched: with the range cut to 45 ports 2 of 24 remote-resume runs failed that way, each beside a pair of touching
 * picks. An ephemeral port (`listen(0)`) is worse: macOS hands those out in sequence across processes, so a
 * parallel worker's next `listen(0)` lands on base + 1 (devices.test.ts "finds a host that took the next port").
 * A worker walks its own band run by run, so its picks never touch each other either, and a run that something
 * already listens on is skipped.
 */
export async function freePortRun(count = REMOTE_PORT_SPAN): Promise<number> {
	const first = band();
	for (let attempt = 0; attempt < BAND_PORTS / count; attempt++) {
		let offset = cursors.get(first) ?? Math.floor(Math.random() * BAND_PORTS);
		if (offset + count > BAND_PORTS) offset = 0;
		cursors.set(first, offset + count);
		const base = first + offset;
		const held: Server[] = [];
		let free = true;
		for (let i = 0; i < count && free; i++) {
			const server = createServer();
			const { promise, resolve } = Promise.withResolvers<boolean>();
			server.once("error", () => resolve(false));
			server.listen(base + i, "127.0.0.1", () => resolve(true));
			free = await promise;
			if (free) held.push(server);
		}
		await Promise.all(
			held.map(server => {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				return promise;
			}),
		);
		if (free) return base;
	}
	throw new Error("no run of free ports in this worker's band");
}
