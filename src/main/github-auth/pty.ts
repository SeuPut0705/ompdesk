/**
 * A pseudo-terminal for `gh auth login`, which refuses to run without a TTY.
 * Production runs it in stock omp's `PtySession` inside the stock helper
 * worker (`pty.request` in resources/gui-bridge/stock-helper/terminals.ts):
 * no second native addon, and the worker's stdin EOF kills it with the app.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { TerminalSnapshot } from "../../shared/terminal-types";
import { stockHelperRequest } from "../stock-helper";

export interface PtyChunk {
	/** Output since the previous read (may be empty when the process just exited). */
	data: string;
	exited: boolean;
	exitCode?: number;
	error?: string;
}

export interface PtyHandle {
	/** Resolves with the next output or the exit; after an exit chunk, never call again. */
	read(): Promise<PtyChunk>;
	write(data: string): void;
	kill(): void;
}

export interface PtySpawn {
	application: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

export type PtyLauncher = (spawn: PtySpawn) => Promise<PtyHandle>;

/** How often the stock helper's scrollback is read while gh runs. */
const POLL_MS = 150;
let sequence = 0;

export const stockPtyLauncher: PtyLauncher = async spawn => {
	const owner = `github-auth:${++sequence}`;
	const request = (operation: unknown) =>
		stockHelperRequest<TerminalSnapshot[]>("pty.request", { owner, ...spawn, operation });
	const [created] = await request({ action: "create", cols: 120, rows: 30 });
	if (!created) throw new Error("The stock helper started no PTY");
	const id = created.id;
	let offset = 0;
	let killed = false;
	return {
		async read() {
			for (;;) {
				if (killed) return { data: "", exited: true };
				const snapshot = (await request({ action: "list", offsets: { [id]: offset } })).find(
					entry => entry.id === id,
				);
				if (!snapshot) return { data: "", exited: true };
				offset = snapshot.offset;
				if (snapshot.output || snapshot.exited) {
					return {
						data: snapshot.output,
						exited: snapshot.exited,
						exitCode: snapshot.exitCode,
						error: snapshot.error,
					};
				}
				await delay(POLL_MS);
			}
		},
		write(data) {
			void request({ action: "write", id, data }).catch(() => undefined);
		},
		kill() {
			killed = true;
			void stockHelperRequest("terminal.dispose", { owner }).catch(() => undefined);
		},
	};
};
