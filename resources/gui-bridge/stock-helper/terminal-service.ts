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
	constructor(readonly factory: () => Pty) {}

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
		};
		try {
			void pty
				.startArgv(entry.options, (error, chunk) => {
					if (entry.pty !== pty) return;
					if (error) entry.error = error.message;
					else append(chunk);
				})
				.then(
					result => {
						if (entry.pty !== pty) return;
						entry.exited = true;
						entry.exitCode = result.exitCode;
					},
					error => {
						if (entry.pty !== pty) return;
						entry.exited = true;
						entry.error = error instanceof Error ? error.message : String(error);
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
					break;
				case "close":
					if (!entry.exited) entry.pty.kill();
					this.#entries.delete(operation.id);
					break;
				case "restart":
					if (!entry.exited) entry.pty.kill();
					entry.pty = this.factory();
					this.#start(entry);
					break;
				case "clear":
					entry.base += entry.output.length;
					entry.output = "";
					break;
			}
		}
		return [...this.#entries]
			.filter(([, entry]) => entry.owner === owner)
			.map(([id, entry]) => ({
				id,
				output:
					operation.action !== "list" || (operation.offsets && operation.offsets[id] === undefined)
						? ""
						: entry.output.slice(Math.max(0, (operation.offsets?.[id] ?? 0) - entry.base)),
				offset: entry.base + entry.output.length,
				exited: entry.exited,
				exitCode: entry.exitCode,
				error: entry.error,
			}));
	}

	dispose(owner?: string): void {
		for (const [id, entry] of this.#entries) {
			if (owner !== undefined && entry.owner !== owner) continue;
			if (!entry.exited) entry.pty.kill();
			this.#entries.delete(id);
		}
	}
}
