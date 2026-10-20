/**
 * Test-only: ports for a remote host under test (unit tests and the two-app e2e harness), free of vitest so the
 * Playwright side can import it.
 */
import { createServer, type Server } from "node:net";
import { REMOTE_PORT_SPAN } from "./address";

/**
 * Lowest port of a run of `count` ports free on 127.0.0.1 right now, below every OS's ephemeral range (macOS and
 * Windows 49152-65535, Linux 32768-60999). WHY: a host takes its first free candidate and a device takes the first
 * candidate that answers, so the run must hold nothing but the test's own. An ephemeral port (`listen(0)`) is a bad
 * base: macOS hands ephemeral ports out in sequence across processes, so the next `listen(0)` of a parallel test
 * worker (another file's RemoteHost) lands on base + 1, and the device connected to that host instead
 * (`key_mismatch`; devices.test.ts "finds a host that took the next port", 1 run in 6 under the full remote suite).
 * Explicit binds here come only from such picks, at random spots of a 12,000-port range.
 */
export async function freePortRun(count = REMOTE_PORT_SPAN): Promise<number> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const base = 20_000 + Math.floor(Math.random() * 12_000);
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
	throw new Error("no run of free ports below the ephemeral range");
}
