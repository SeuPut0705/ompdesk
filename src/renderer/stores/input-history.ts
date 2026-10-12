import { z } from "zod";
import { create } from "zustand";
import { reportRuntimeError } from "../lib/runtime-errors";
import { focusedTabRpc, type TabRpc } from "../lib/tab-rpc";

/** Stock HistoryStorage owns persistence/search. Remote tabs use their omp host's
 * history, never the client's local history. Only local tabs migrate legacy prefs. */
export interface InputHistoryEntry {
	prompt: string;
	ts: number;
	cwd?: string;
	device?: string;
	/** Stock excludes secrets; they remain recallable only during this renderer run. */
	transient?: boolean;
}

export interface InputHistoryContext {
	cwd: string;
	owner: string;
	device?: string;
}

export function workspaceHistory(entries: InputHistoryEntry[], cwd?: string): InputHistoryEntry[] {
	return cwd === undefined ? entries : entries.filter(entry => entry.cwd === cwd);
}

// Stock HistoryStorage.search cannot see transient secret inputs; this filter serves only those renderer-owned drafts.
export function filterHistory(entries: InputHistoryEntry[], query: string, limit = 100): InputHistoryEntry[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	return entries
		.filter(entry => tokens.every(token => entry.prompt.toLowerCase().includes(token)))
		.slice(0, Math.max(0, limit));
}

const historySchema = z.array(z.object({ prompt: z.string(), created_at: z.number(), cwd: z.string().optional() }));
function stockEntries(data: unknown, device?: string): InputHistoryEntry[] {
	return historySchema
		.parse(data)
		.map(entry => ({ prompt: entry.prompt, ts: entry.created_at * 1000, cwd: entry.cwd, device }));
}

// Whitespace-insensitive key for "stock already holds this prompt"; looser than stock's
// own normalization on purpose, so a near-duplicate is skipped rather than re-stamped.
const promptKey = (prompt: string) => prompt.replace(/\s+/g, " ").trim();

async function stockHolds(rpc: TabRpc, prompt: string, recent: Set<string>): Promise<boolean> {
	const key = promptKey(prompt);
	if (recent.has(key)) return true;
	const response = await rpc.historySearch(prompt, 1000);
	if (!response.success) throw new Error(response.error);
	return stockEntries(response.data).some(entry => promptKey(entry.prompt) === key);
}

let migration: Promise<void> | undefined;
async function migratePrefs(rpc: TabRpc): Promise<void> {
	if (migration) return migration;
	migration = (async () => {
		const raw = await window.omp.prefs.get("inputHistory");
		if (!Array.isArray(raw)) return;
		// Stock's add() always stamps "now" and bumps use_count, so recording a prompt stock
		// already holds would lift an old prompt above newer ones. Only missing prompts are
		// recorded; they land newest, which is where the GUI's own ↑ showed them before.
		const recentResponse = await rpc.historyRecent(1000);
		if (!recentResponse.success) throw new Error(recentResponse.error);
		const recent = new Set(stockEntries(recentResponse.data).map(entry => promptKey(entry.prompt)));
		// Oldest first preserves the legacy newest-first order after stock upserts.
		for (const item of [...raw].reverse()) {
			const entry =
				typeof item === "string"
					? { prompt: item }
					: z.object({ prompt: z.string(), cwd: z.string().optional() }).safeParse(item).data;
			if (!entry?.prompt.trim() || (await stockHolds(rpc, entry.prompt, recent))) continue;
			const result = await rpc.historyRecord(entry.prompt, entry.cwd);
			if (!result.success) throw new Error(result.error);
			recent.add(promptKey(entry.prompt));
		}
		// Setting undefined removes the serialized prefs key; no second history copy remains.
		await window.omp.prefs.set("inputHistory", undefined);
	})().finally(() => {
		migration = undefined;
	});
	return migration;
}

interface InputHistoryStore {
	entries: InputHistoryEntry[];
	hydrated: boolean;
	navIndex: number;
	navDraft: string;
	navContext: InputHistoryContext | undefined;
	hydrate: (rpc?: TabRpc, device?: string) => Promise<void>;
	record: (prompt: string, cwd?: string, rpc?: TabRpc, device?: string) => void;
	search: (query: string, limit?: number, cwd?: string, rpc?: TabRpc, device?: string) => Promise<InputHistoryEntry[]>;
	recent: (limit?: number) => InputHistoryEntry[];
	prev: (currentDraft: string, context?: InputHistoryContext) => string | undefined;
	next: (context?: InputHistoryContext) => string | undefined;
	resetNav: () => void;
}

export const useInputHistoryStore = create<InputHistoryStore>()((set, get) => ({
	entries: [],
	hydrated: false,
	navIndex: -1,
	navDraft: "",
	navContext: undefined,
	hydrate: async (rpc = focusedTabRpc(), device) => {
		try {
			if (device === undefined) await migratePrefs(rpc);
			const response = await rpc.historyRecent(200);
			if (!response.success) throw new Error(response.error);
			const incoming = stockEntries(response.data, device);
			set(state => ({
				entries: [
					...state.entries.filter(entry => entry.device !== device || entry.transient),
					...incoming.filter(
						entry =>
							!state.entries.some(old => old.device === device && old.transient && old.prompt === entry.prompt),
					),
				].sort((a, b) => b.ts - a.ts),
				hydrated: true,
			}));
		} catch (error) {
			// Background: loading recall entries is never something the user asked for, so a
			// failure must not interrupt with "Command failed"; the next ready/send retries it.
			reportRuntimeError("background-task", error, { details: { task: "history_recent" } });
		}
	},
	record: (prompt, cwd, rpc = focusedTabRpc(), device) => {
		const trimmed = prompt.trim();
		if (!trimmed) return;
		const entry: InputHistoryEntry = { prompt: trimmed, ts: Date.now(), cwd, device, transient: true };
		set(state => ({
			entries: [entry, ...state.entries.filter(old => old.device !== device || old.prompt !== trimmed)],
			navIndex: -1,
			navDraft: "",
			navContext: undefined,
		}));
		void rpc
			.historyRecord(trimmed, cwd)
			.then(response => {
				if (!response.success) throw new Error(response.error);
				const { skipped } = z.object({ skipped: z.boolean() }).parse(response.data);
				if (!skipped) {
					set(state => ({
						entries: state.entries.map(old => (old === entry ? { ...old, transient: false } : old)),
					}));
					return get().hydrate(rpc, device);
				}
			})
			// The prompt itself was sent. A history write that fails keeps the entry in memory
			// (transient, still recallable) and is logged instead of toasted.
			.catch(error => reportRuntimeError("background-task", error, { details: { task: "history_record" } }));
	},
	search: async (query, limit = 100, cwd, rpc = focusedTabRpc(), device) => {
		const response = await (query.trim() ? rpc.historySearch(query, limit, cwd) : rpc.historyRecent(limit, cwd));
		if (!response.success) throw new Error(response.error);
		const transient = filterHistory(
			workspaceHistory(
				get().entries.filter(entry => entry.device === device && entry.transient),
				cwd,
			),
			query,
			limit,
		);
		const stored = stockEntries(response.data, device).filter(
			entry => !transient.some(old => old.prompt === entry.prompt),
		);
		return [...transient, ...stored].sort((a, b) => b.ts - a.ts).slice(0, limit);
	},
	recent: (limit = 100) => get().entries.slice(0, limit),
	prev: (currentDraft, context) => {
		const state = get();
		const entries = workspaceHistory(
			state.entries.filter(entry => entry.device === context?.device),
			context?.cwd,
		);
		const sameContext =
			state.navContext?.owner === context?.owner &&
			state.navContext?.cwd === context?.cwd &&
			state.navContext?.device === context?.device;
		const navIndex = sameContext ? state.navIndex : -1;
		const navDraft = sameContext ? state.navDraft : "";
		if (entries.length === 0) return undefined;
		const nextIndex = navIndex + 1;
		if (nextIndex >= entries.length) return undefined;
		set({ navIndex: nextIndex, navDraft: navIndex === -1 ? currentDraft : navDraft, navContext: context });
		return entries[nextIndex].prompt;
	},
	next: context => {
		const { entries: allEntries, navIndex, navDraft, navContext } = get();
		if (
			navContext?.owner !== context?.owner ||
			navContext?.cwd !== context?.cwd ||
			navContext?.device !== context?.device
		)
			return undefined;
		const entries = workspaceHistory(
			allEntries.filter(entry => entry.device === context?.device),
			context?.cwd,
		);
		if (navIndex === -1) return undefined;
		const nextIndex = navIndex - 1;
		if (nextIndex === -1) {
			set({ navIndex: -1, navDraft: "" });
			return navDraft;
		}
		set({ navIndex: nextIndex });
		return entries[nextIndex]?.prompt;
	},
	resetNav: () => {
		if (get().navIndex !== -1 || get().navContext !== undefined)
			set({ navIndex: -1, navDraft: "", navContext: undefined });
	},
}));
