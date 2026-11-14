import { INBOX_PROVENANCE_SOURCE, type InboxContextReceipt } from "./agent-inbox-contracts";

interface ObserverOptions {
	instance: string;
	path(): string | undefined;
	owns(id: string): boolean;
	append(receipt: InboxContextReceipt): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function meaningful(event: unknown): boolean {
	const value = record(event);
	if (!value) return false;
	if (value.type === "text_delta" || value.type === "thinking_delta")
		return typeof value.delta === "string" && value.delta.length > 0;
	return value.type === "toolcall_start" || value.type === "toolcall_delta" || value.type === "toolcall_end";
}

/** Observes the original provider stream. It never starts a turn, consumes an iterator, or cancels work. */
export class InboxContextObserver {
	readonly #options: ObserverOptions;
	readonly #observed = new Map<string, Set<string>>();
	readonly #pending = new Map<string, InboxContextReceipt>();
	#revision = 0;
	#request = 0;
	#active: { path: string | undefined; revision: number; ids: ReadonlySet<string> } | undefined;

	constructor(options: ObserverOptions) {
		this.#options = options;
	}

	invalidate(): void {
		this.#revision++;
	}

	/** Avoid yielding a generation that already carries the inventory. This is not a consumption receipt. */
	includes(ids: readonly string[]): boolean {
		return (
			this.#active?.revision === this.#revision &&
			this.#active.path === this.#options.path() &&
			ids.every(id => this.#active?.ids.has(id))
		);
	}

	capture(context: unknown): (event: unknown) => void {
		const path = this.#options.path();
		const revision = this.#revision;
		const requestId = `${this.#options.instance}:${++this.#request}`;
		const ids = new Set<string>();
		const messages = record(context)?.messages;
		if (Array.isArray(messages)) {
			for (const message of messages) {
				const root = record(message);
				const provenance = record(root?.provenance);
				if (
					root?.attribution === "agent" &&
					provenance?.source === INBOX_PROVENANCE_SOURCE &&
					typeof provenance.id === "string" &&
					this.#options.owns(provenance.id)
				)
					ids.add(provenance.id);
			}
		}
		this.#active = { path, revision, ids };
		let seenOutput = false;
		return event => {
			if (seenOutput || !path || revision !== this.#revision || this.#options.path() !== path || !meaningful(event))
				return;
			seenOutput = true;
			const observed = this.#observed.get(path) ?? new Set<string>();
			const fresh = [...ids].filter(id => !observed.has(id));
			if (fresh.length === 0) return;
			for (const id of fresh) observed.add(id);
			this.#observed.set(path, observed);
			const receipt: InboxContextReceipt = {
				requestId,
				sessionPath: path,
				instance: this.#options.instance,
				ids: fresh,
				evidence: "context-id-and-provider-output",
			};
			this.#pending.set(requestId, receipt);
			this.retry();
		};
	}

	/** A failed journal append remains owned here. Never write it into a replacement session. */
	retry(): void {
		for (const [requestId, receipt] of this.#pending) {
			if (this.#options.path() !== receipt.sessionPath) continue;
			try {
				this.#options.append(receipt);
				this.#pending.delete(requestId);
			} catch {
				// The provider's output must continue; native inventory still owns the unacknowledged entry.
			}
		}
	}

	pending(): readonly InboxContextReceipt[] {
		return [...this.#pending.values()];
	}
}
