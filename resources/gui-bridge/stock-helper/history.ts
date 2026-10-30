import { join } from "node:path";

/** The stock `HistoryStorage` reads the composer's ↑ and ⌃R use. */
interface StockHistory {
	getRecent(limit: number, filter: { cwd?: string }): unknown[];
	search(query: string, limit: number, filter: { cwd?: string }): unknown[];
}

let opened: Promise<StockHistory> | undefined;
/** Stock's process-wide handle on the one history.db every omp on this computer writes (`HistoryStorage.open`). */
function stockHistory(): Promise<StockHistory> {
	opened ??= (async () => {
		const root = process.env.OMP_PACKAGE_ROOT;
		if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
		// Runtime-selected: the store belongs to the user's resolved omp installation.
		const module = await import(
			Bun.resolveSync("@oh-my-pi/pi-coding-agent/session/history-storage", join(root, "package.json"))
		);
		if (typeof module.HistoryStorage?.open !== "function") throw new Error("Installed omp has no HistoryStorage");
		const store = module.HistoryStorage.open() as Partial<StockHistory>;
		if (typeof store.getRecent !== "function" || typeof store.search !== "function")
			throw new Error("Installed omp's HistoryStorage cannot read history");
		return store as StockHistory;
	})().catch(error => {
		opened = undefined;
		throw error;
	});
	return opened;
}

function filter(params: unknown): { limit?: number; cwd?: string; query?: string } {
	if (typeof params !== "object" || params === null) return {};
	const { limit, cwd, query } = params as Record<string, unknown>;
	return {
		...(typeof limit === "number" ? { limit } : {}),
		...(typeof cwd === "string" ? { cwd } : {}),
		...(typeof query === "string" ? { query } : {}),
	};
}

/** Read-only, sub-millisecond SQLite reads a composer waits on: answered beside the serial queue, never behind a
 * session-list scan. Writes (`history_record`) stay in the tab's omp, which knows the session id. */
export const UNQUEUED_METHODS: Readonly<Record<string, true>> = { "history.recent": true, "history.search": true };

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"history.recent": async params => {
		const { limit, cwd } = filter(params);
		return (await stockHistory()).getRecent(limit ?? 200, { cwd });
	},
	"history.search": async params => {
		const { limit, cwd, query } = filter(params);
		if (query === undefined) throw new Error("history.search needs a query");
		return (await stockHistory()).search(query, limit ?? 100, { cwd });
	},
};
