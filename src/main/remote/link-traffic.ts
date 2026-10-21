/**
 * What a host link carried, by kind, for the runtime log: a user reporting a constant stream over Tailscale
 * (20 Oct 2026: 170-350 KB/s) could only be answered by building a harness (`link-traffic-report.test.ts`). The
 * counter keeps wire bytes and frame counts per kind (`tx evt tab.event events`, `rx req tab.command`, ...) and, for
 * a batch of omp events, how many of each type it held. It never holds a payload, an address or a key.
 */
import { TAB_EVENT } from "./app-protocol";
import type { Link } from "./wire";

/** A window that moved fewer bytes than this is not worth a line (an idle link sends about 1 KiB a minute in pings). */
export const TRAFFIC_LOG_MIN_BYTES = 256 * 1024;
export const TRAFFIC_LOG_MS = 60_000;
/** Kinds and omp types written per line. */
const TOP = 5;
/** Kinds counted separately; a peer cannot grow the table past this by inventing method names. */
const MAX_KINDS = 128;
const MAX_OPEN_REQUESTS = 256;
const MAX_NAME_CHARS = 64;

export interface TrafficRow {
	kind: string;
	frames: number;
	bytes: number;
}

export interface TrafficWindow {
	tx: number;
	rx: number;
	/** Every kind seen, the biggest first. */
	rows: TrafficRow[];
	/** omp events inside `tab.event events` batches and subagent frames inside batched `subagentFrame` ones, by type. */
	batched: Record<string, number>;
}

/** Tab events whose `arg` names its own frame type; the type belongs in the kind (`subagentFrame/subagent_progress`). */
const TYPED_TAB_EVENTS: Record<string, true> = { subagentFrame: true, liveFrame: true, btwFrame: true };

function name(value: unknown): string {
	return typeof value === "string" ? value.slice(0, MAX_NAME_CHARS) : "?";
}

export class LinkTraffic {
	readonly #rows = new Map<string, TrafficRow>();
	readonly #batched = new Map<string, number>();
	/** Methods of requests seen, by id, until their answer passes: an answer is sized under its request's method. */
	readonly #methods = new Map<number, string>();
	#tx = 0;
	#rx = 0;

	record(direction: "tx" | "rx", message: object, bytes: number): void {
		const kind = `${direction} ${this.#kindOf(message)}`;
		if (direction === "tx") this.#tx += bytes;
		else this.#rx += bytes;
		let row = this.#rows.get(kind);
		if (!row) {
			if (this.#rows.size >= MAX_KINDS) return;
			row = { kind, frames: 0, bytes: 0 };
			this.#rows.set(kind, row);
		}
		row.frames++;
		row.bytes += bytes;
	}

	/** What was counted since the last call; the next window starts empty. */
	take(): TrafficWindow {
		const window: TrafficWindow = {
			tx: this.#tx,
			rx: this.#rx,
			rows: [...this.#rows.values()].sort((a, b) => b.bytes - a.bytes),
			batched: Object.fromEntries(this.#batched),
		};
		this.#rows.clear();
		this.#batched.clear();
		this.#tx = 0;
		this.#rx = 0;
		return window;
	}

	#kindOf(message: object): string {
		const { t, id, method, event, data, params } = message as Record<string, unknown>;
		if (t === "req") {
			const asked = this.#methodOf(method, params);
			if (typeof id === "number" && this.#methods.size < MAX_OPEN_REQUESTS) this.#methods.set(id, asked);
			return `req ${asked}`;
		}
		if (t === "res") {
			const asked = typeof id === "number" ? this.#methods.get(id) : undefined;
			if (typeof id === "number") this.#methods.delete(id);
			return asked === undefined ? "res" : `res ${asked}`;
		}
		if (t === "evt") return event === TAB_EVENT ? this.#tabEventKind(data) : `evt ${name(event)}`;
		return name(t);
	}

	/**
	 * A request's method, and for `tab.command` the RPC command's type with it: every poll of a viewed host tab is a
	 * `tab.command`, and a link moving 3 MB a minute of their answers (21 Oct 2026) said nothing of which one.
	 */
	#methodOf(method: unknown, params: unknown): string {
		const base = name(method);
		if (base !== "tab.command") return base;
		const type = ((params as { command?: { type?: unknown } } | null)?.command as { type?: unknown } | undefined)
			?.type;
		return typeof type === "string" ? `${base}/${name(type)}` : base;
	}

	#tabEventKind(data: unknown): string {
		const { name: tabEvent, arg } = (data ?? {}) as { name?: unknown; arg?: unknown };
		const base = `evt ${TAB_EVENT} ${name(tabEvent)}`;
		if (typeof tabEvent !== "string") return base;
		if (Array.isArray(arg) && (tabEvent === "events" || TYPED_TAB_EVENTS[tabEvent] === true)) {
			for (const item of arg) {
				const type = name((item as { type?: unknown } | null)?.type);
				this.#batched.set(type, (this.#batched.get(type) ?? 0) + 1);
			}
			// A flush of subagent frames (`slimProgress`) holds frames of several types: one kind, each type counted.
			return tabEvent === "events" ? base : `${base}/batch`;
		}
		if (TYPED_TAB_EVENTS[tabEvent] === true) return `${base}/${name((arg as { type?: unknown } | null)?.type)}`;
		return base;
	}
}

/**
 * Count `link` and write one line a minute while it moves at least {@link TRAFFIC_LOG_MIN_BYTES}, and one more
 * when it closes with such a window open. `log` gets the line's details.
 */
export function logLinkTraffic(
	link: Link,
	options: { now: () => number; log: (details: Record<string, unknown>) => void; everyMs?: number },
): void {
	const traffic = new LinkTraffic();
	link.onTraffic((direction, message, bytes) => traffic.record(direction, message, bytes));
	let since = options.now();
	const flush = (): void => {
		const window = traffic.take();
		const now = options.now();
		const ms = now - since;
		since = now;
		if (window.tx + window.rx < TRAFFIC_LOG_MIN_BYTES) return;
		const events = Object.entries(window.batched)
			.sort((a, b) => b[1] - a[1])
			.slice(0, TOP);
		// As JSON text: the runtime log keeps only primitive details, and drops an array or object whole (every
		// traffic line until 21 Oct 2026 read `ms`, `tx`, `rx` and nothing of what the bytes were).
		options.log({
			ms,
			tx: window.tx,
			rx: window.rx,
			top: JSON.stringify(window.rows.slice(0, TOP)),
			events: JSON.stringify(Object.fromEntries(events)),
		});
	};
	const timer = setInterval(flush, options.everyMs ?? TRAFFIC_LOG_MS);
	timer.unref();
	link.onClose(() => {
		clearInterval(timer);
		flush();
	});
}
