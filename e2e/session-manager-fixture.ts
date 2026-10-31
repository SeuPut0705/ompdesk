/** Filesystem-backed fake of the two stock `SessionManager` statics `sessions.createNamed` calls; not app logic. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Where the fake omp keeps its session files (`e2e/fixture/rpc-ui.ts` writes beside them). */
function sessionDirectory(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? "", "sessions", "fixture");
}

// biome-ignore lint/complexity/noStaticOnlyClass: the fake mirrors stock's `SessionManager`, whose callers use its statics.
export class SessionManager {
	/** Stock writes a header-only file in the cwd's session directory and answers its path. */
	static createEmptySessionFile(cwd: string): string {
		const id = crypto.randomUUID();
		const timestamp = new Date().toISOString();
		const file = join(sessionDirectory(), `${id}.jsonl`);
		mkdirSync(sessionDirectory(), { recursive: true });
		const lines = [
			{ type: "title", v: 1, title: "", updatedAt: timestamp },
			{ type: "session", version: 3, id, timestamp, cwd: resolve(cwd) },
		];
		writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		return file;
	}

	/** Stock's rename of a file no omp has open: the title slot holds the new title; answers it. */
	static async renameSessionTitle(sessionPath: string, title: string): Promise<string | null> {
		const lines = readFileSync(sessionPath, "utf8").split("\n");
		const slot = lines.findIndex(line => line.includes('"type":"title"'));
		if (slot === -1) return null;
		lines[slot] = JSON.stringify({ type: "title", v: 1, title, updatedAt: new Date().toISOString() });
		writeFileSync(sessionPath, lines.join("\n"));
		return title;
	}
}
