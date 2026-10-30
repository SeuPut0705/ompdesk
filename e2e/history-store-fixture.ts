/**
 * Stand-in for stock's `session/history-storage`, as the fake omp's install exposes it (`fixtureOmp` in harness.ts).
 * The real one is one `history.db` every omp on the machine writes and the stock helper reads; here that shared store
 * is a JSON file in the agent dir, which the fake omp's bridge (fixture/rpc-ui.ts `history_record`) writes through
 * `recordHistory` and the helper reads through `HistoryStorage`, in their own processes.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface FixtureHistoryEntry {
	prompt: string;
	created_at: number;
	cwd?: string;
}

function historyFile(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required for the fixture history");
	return path.join(agentDir, "fixture-history.json");
}

function readHistory(): FixtureHistoryEntry[] {
	try {
		return JSON.parse(fs.readFileSync(historyFile(), "utf8")) as FixtureHistoryEntry[];
	} catch {
		return [];
	}
}

/** Newest first, one entry per prompt, like stock's upsert. */
export function recordHistory(prompt: string, cwd: string | undefined): void {
	const rest = readHistory().filter(entry => entry.prompt !== prompt);
	fs.writeFileSync(historyFile(), JSON.stringify([{ prompt, created_at: Date.now() / 1000, cwd }, ...rest]));
}

export class HistoryStorage {
	static open(): HistoryStorage {
		return new HistoryStorage();
	}

	getRecent(limit: number, filter: { cwd?: string }): FixtureHistoryEntry[] {
		return readHistory()
			.filter(entry => !filter.cwd || entry.cwd === filter.cwd)
			.slice(0, limit);
	}

	search(query: string, limit: number, filter: { cwd?: string }): FixtureHistoryEntry[] {
		const tokens = query.toLowerCase().split(/\s+/);
		return readHistory()
			.filter(
				entry =>
					(!filter.cwd || entry.cwd === filter.cwd) &&
					tokens.every(token => entry.prompt.toLowerCase().includes(token)),
			)
			.slice(0, limit);
	}
}
