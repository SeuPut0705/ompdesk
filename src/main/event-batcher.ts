/**
 * Batches agent session events at roughly one 30Hz presentation frame.
 * Never drops message_update or lifecycle events.
 * Drops intermediate tool_execution_update under backpressure (>1000 buffered).
 */
import type { AgentSessionEvent } from "../shared/rpc-types";

const BATCH_INTERVAL_MS = 32;
const MAX_BUFFER_SIZE = 1000;

type FlushCallback = (events: AgentSessionEvent[]) => void;

export class EventBatcher {
	#pending: AgentSessionEvent[] = [];
	#scheduled = false;
	#flush: FlushCallback;
	#disposed = false;
	#flushTimer: NodeJS.Timeout | null = null;

	constructor(flush: FlushCallback) {
		this.#flush = flush;
	}

	push(event: AgentSessionEvent): void {
		if (this.#disposed) return;

		// Backpressure: drop intermediate tool_execution_update if buffer is full
		if (this.#pending.length >= MAX_BUFFER_SIZE && event.type === "tool_execution_update") {
			return;
		}

		this.#pending.push(event);

		if (!this.#scheduled) {
			this.#scheduled = true;
			this.#flushTimer = setTimeout(() => this.#doFlush(), BATCH_INTERVAL_MS);
		}
	}

	#doFlush(): void {
		if (this.#flushTimer !== null) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		this.#scheduled = false;
		if (this.#pending.length === 0 || this.#disposed) return;
		const batch = this.#pending;
		this.#pending = [];
		this.#flush(batch);
	}

	/** Flush immediately (e.g., on sidecar disconnect). */
	flushNow(): void {
		if (this.#pending.length > 0) {
			this.#doFlush();
		}
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#flushTimer !== null) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		this.#scheduled = false;
		this.#pending = [];
	}
}
