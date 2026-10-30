/**
 * A terminal viewport's read loop (design §7.2), a desktop window's and a web viewer's alike: it asks once and the
 * host holds the answer until the PTY writes or changes (at most 1 s, `waitMs`), so an idle shell costs one request a
 * second (the desktop used to ask every 80 ms). The viewer's next request is also its acknowledgement: it is made only
 * after xterm has taken the last output (`write` resolves when xterm has parsed it), carrying the offset the viewer has
 * reached, and the host cuts each answer to an output budget (64 KB), so a runaway program feeds the screen as fast as
 * it can draw, never faster.
 *
 * A host that predates the long poll answers at once with nothing new; `MIN_GAP_MS` keeps that from becoming a
 * busy loop.
 */
import {
	TERMINAL_OUTPUT_BUDGET,
	TERMINAL_POLL_MAX_WAIT_MS,
	type TerminalOperation,
	type TerminalSnapshot,
} from "../../shared/terminal-types";

/** The shortest an empty answer may take before the next request goes out (80 ms, the old desktop poll's period). */
export const MIN_GAP_MS = 80;
/** Pause after a failed request before asking again. */
export const RETRY_MS = 1000;

export interface TerminalPollOptions {
	id: string;
	/** One terminal operation, or null when the request failed (the caller has shown the error). */
	request(operation: TerminalOperation): Promise<TerminalSnapshot[] | null>;
	/** Give xterm `output`; resolves when xterm has parsed it. The next request waits for it. */
	write(output: string): Promise<void>;
	/** A snapshot of the session arrived (exit state, size, lease). */
	onSnapshot(snapshot: TerminalSnapshot): void;
	stopped(): boolean;
	/** Where the stream starts (0 reads the whole scrollback). */
	offset?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
};

/** Read `id` until `stopped()`. Never has more than one request in flight. */
export async function pollTerminal(options: TerminalPollOptions): Promise<void> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? realSleep;
	let offset = options.offset ?? 0;
	while (!options.stopped()) {
		const started = now();
		const snapshots = await options.request({
			action: "list",
			offsets: { [options.id]: offset },
			waitMs: TERMINAL_POLL_MAX_WAIT_MS,
			budget: TERMINAL_OUTPUT_BUDGET,
		});
		if (options.stopped()) return;
		if (!snapshots) {
			await sleep(RETRY_MS);
			continue;
		}
		const snapshot = snapshots.find(item => item.id === options.id);
		if (!snapshot) {
			// The session is gone (closed elsewhere): nothing to read; the panel's own list shows it.
			await sleep(RETRY_MS);
			continue;
		}
		options.onSnapshot(snapshot);
		if (snapshot.output) {
			// The acknowledgement: asking again only once xterm has the output.
			await options.write(snapshot.output);
			offset = snapshot.offset;
			continue;
		}
		offset = snapshot.offset;
		const took = now() - started;
		if (took < MIN_GAP_MS) await sleep(MIN_GAP_MS - took);
	}
}
