/**
 * The tool calls of one session that started and whose result message has not been emitted yet. A quit waits on
 * this set (quit-journal.ts) so an aborted call's result reaches the journal before the process ends.
 */
export interface PendingToolCalls {
	start(toolCallId: string): void;
	settle(toolCallId: string): void;
	readonly size: number;
	/** Resolves true once no call is pending, false after `timeoutMs` with some still pending. */
	settled(timeoutMs: number): Promise<boolean>;
}

export function createPendingToolCalls(): PendingToolCalls {
	const pending = new Set<string>();
	const waiters = new Set<() => void>();
	return {
		start: id => {
			pending.add(id);
		},
		settle: id => {
			if (!pending.delete(id) || pending.size > 0) return;
			for (const release of [...waiters]) release();
		},
		get size() {
			return pending.size;
		},
		settled: timeoutMs => {
			if (pending.size === 0) return Promise.resolve(true);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			const release = () => {
				clearTimeout(timer);
				waiters.delete(release);
				resolve(pending.size === 0);
			};
			const timer = setTimeout(release, timeoutMs);
			waiters.add(release);
			return promise;
		},
	};
}
