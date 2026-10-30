import { randomUUID } from "node:crypto";
import type { TerminalOperation, TerminalSnapshot } from "../../../src/shared/terminal-types";

export interface PtyOptions {
	application: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
}
export interface Pty {
	startArgv(
		options: PtyOptions,
		onChunk: (error: Error | null, chunk: string) => void,
	): Promise<{ exitCode?: number }>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}
interface Entry {
	owner: string;
	pty: Pty;
	options: PtyOptions;
	output: string;
	base: number;
	exited: boolean;
	exitCode?: number;
	error?: string;
}
const SCROLLBACK_CHARS = 1_000_000;
export class TerminalService {
	readonly #entries = new Map<string, Entry>();
	/** Long polls (`list` with `waitMs`) waiting for the next output or change of any session. */
	readonly #waiters = new Set<() => void>();
	/**
	 * What a viewer shows besides output, changed so far: exits and failures, a resize, a restart, a close, a clear, a
	 * claim of the size. A poll that began earlier answers when this moved, so another window showing the same PTY
	 * follows at once.
	 */
	#changed = 0;
	constructor(readonly factory: () => Pty) {}

	#wake(changed = false): void {
		if (changed) this.#changed += 1;
		for (const wake of [...this.#waiters]) wake();
	}

	#start(entry: Entry): void {
		entry.exited = false;
		entry.exitCode = undefined;
		entry.error = undefined;
		const pty = entry.pty;
		const append = (text: string) => {
			entry.output += text;
			if (entry.output.length > SCROLLBACK_CHARS) {
				const cut = entry.output.length - SCROLLBACK_CHARS;
				entry.output = entry.output.slice(cut);
				entry.base += cut;
			}
			this.#wake();
		};
		try {
			void pty
				.startArgv(entry.options, (error, chunk) => {
					if (entry.pty !== pty) return;
					if (error) entry.error = error.message;
					else append(chunk);
					if (error) this.#wake(true);
				})
				.then(
					result => {
						if (entry.pty !== pty) return;
						entry.exited = true;
						entry.exitCode = result.exitCode;
						this.#wake(true);
					},
					error => {
						if (entry.pty !== pty) return;
						entry.exited = true;
						entry.error = error instanceof Error ? error.message : String(error);
						this.#wake(true);
					},
				);
		} catch (error) {
			entry.exited = true;
			entry.error = error instanceof Error ? error.message : String(error);
		}
	}

	request(owner: string, operation: TerminalOperation, options: PtyOptions): TerminalSnapshot[] {
		if (operation.action === "create") {
			const entry: Entry = {
				owner,
				pty: this.factory(),
				options: { ...options, cols: operation.cols, rows: operation.rows },
				output: "",
				base: 0,
				exited: false,
			};
			this.#entries.set(randomUUID(), entry);
			this.#start(entry);
		} else if (operation.action === "claim") {
			// Main moved the size lease to the claiming viewer; the others' polls answer with their new standing.
			this.#wake(true);
		} else if (operation.action !== "list") {
			const entry = this.#entries.get(operation.id);
			if (!entry || entry.owner !== owner) throw new Error("Terminal not found");
			switch (operation.action) {
				case "write":
					if (!entry.exited) entry.pty.write(operation.data);
					break;
				case "resize":
					entry.options.cols = operation.cols;
					entry.options.rows = operation.rows;
					if (!entry.exited) entry.pty.resize(operation.cols, operation.rows);
					this.#wake(true);
					break;
				case "close":
					if (!entry.exited) entry.pty.kill();
					this.#entries.delete(operation.id);
					this.#wake(true);
					break;
				case "restart":
					if (!entry.exited) entry.pty.kill();
					entry.pty = this.factory();
					this.#start(entry);
					this.#wake(true);
					break;
				case "clear":
					entry.base += entry.output.length;
					entry.output = "";
					this.#wake(true);
					break;
			}
		}
		return [...this.#entries]
			.filter(([, entry]) => entry.owner === owner)
			.map(([id, entry]) => {
				const listing = operation.action === "list" && !(operation.offsets && operation.offsets[id] === undefined);
				const from = listing ? Math.max(0, (operation.offsets?.[id] ?? 0) - entry.base) : entry.output.length;
				let end = entry.output.length;
				const budget = operation.action === "list" ? operation.budget : undefined;
				if (budget !== undefined && end - from > budget) {
					end = from + budget;
					// Never split a surrogate pair: the next reply would start with its low half.
					const last = entry.output.charCodeAt(end - 1);
					if (end > from && last >= 0xd800 && last <= 0xdbff) end -= 1;
				}
				return {
					id,
					output: listing ? entry.output.slice(from, end) : "",
					offset: entry.base + end,
					exited: entry.exited,
					exitCode: entry.exitCode,
					error: entry.error,
					cols: entry.options.cols,
					rows: entry.options.rows,
				};
			});
	}

	/**
	 * A `list` that holds until one of the owner's sessions has output past its offset, or any session has changed
	 * otherwise since (exit, failure, size, restart, close, clear, claim), or `waitMs` has passed (a viewer's long poll:
	 * nothing is sent while nothing happens). Output already waiting answers at once, so a viewer behind a `budget`
	 * keeps reading without pause.
	 */
	async list(
		owner: string,
		operation: Extract<TerminalOperation, { action: "list" }>,
		options: PtyOptions,
	): Promise<TerminalSnapshot[]> {
		const waitMs = operation.waitMs ?? 0;
		const pending = () =>
			[...this.#entries].some(
				([id, entry]) =>
					entry.owner === owner &&
					operation.offsets?.[id] !== undefined &&
					entry.base + entry.output.length > (operation.offsets[id] ?? 0),
			);
		const changed = this.#changed;
		const deadline = Date.now() + waitMs;
		// Any session's output wakes every poll; each looks again and sleeps on unless it was its own news.
		while (waitMs > 0 && !pending() && this.#changed === changed && Date.now() < deadline) {
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, deadline - Date.now());
			this.#waiters.add(resolve);
			await promise.finally(() => {
				clearTimeout(timer);
				this.#waiters.delete(resolve);
			});
		}
		return this.request(owner, operation, options);
	}

	dispose(owner?: string): void {
		for (const [id, entry] of this.#entries) {
			if (owner !== undefined && entry.owner !== owner) continue;
			if (!entry.exited) entry.pty.kill();
			this.#entries.delete(id);
		}
	}
}
