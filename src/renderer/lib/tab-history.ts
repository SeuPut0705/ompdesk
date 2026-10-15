/**
 * Where the user has been in this window, for three surfaces:
 * - the ⌃⇥ switcher and the tab overview list open tabs most recent first (`mru`);
 * - ⌘[ / ⌘] (Windows ⌥← / ⌥→) step back and forward through what had focus —
 *   a tab, or a page (Settings, Agents, Insights) — like a browser's history.
 *
 * `installTabHistory()` watches the tabs and ui stores once per window (App);
 * the stores themselves stay unaware of it.
 */

import { create } from "zustand";
import { useTabsStore } from "../stores/tabs";
import { type Destination, useUiStore } from "../stores/ui";

/** One place in the history: the focused tab and the destination shown over it. */
export interface HistoryEntry {
	tabId: string | null;
	destination: Destination;
}

/** Back steps kept; the oldest go first. */
const HISTORY_LIMIT = 50;

interface TabHistoryState {
	/** Open tab ids, most recently focused first. */
	mru: string[];
	back: HistoryEntry[];
	forward: HistoryEntry[];
}

export const useTabHistoryStore = create<TabHistoryState>()(() => ({ mru: [], back: [], forward: [] }));

const sameEntry = (a: HistoryEntry, b: HistoryEntry) => a.tabId === b.tabId && a.destination === b.destination;

function currentEntry(): HistoryEntry {
	return { tabId: useTabsStore.getState().activeTabId, destination: useUiStore.getState().destination };
}

/** Set while back/forward applies an entry, so the move itself is not recorded as a new step. */
let navigating = false;

export function installTabHistory(): () => void {
	let last = currentEntry();
	const seed = useTabsStore.getState();
	useTabHistoryStore.setState({
		mru: [
			...(seed.activeTabId ? [seed.activeTabId] : []),
			...seed.tabs.map(tab => tab.id).filter(id => id !== seed.activeTabId),
		],
		back: [],
		forward: [],
	});
	const record = () => {
		const next = currentEntry();
		const tabs = useTabsStore.getState().tabs;
		const open = new Set(tabs.map(tab => tab.id));
		useTabHistoryStore.setState(state => {
			// MRU: the focused tab first, closed tabs out, new tabs at the end.
			const mru = [
				...(next.tabId && open.has(next.tabId) ? [next.tabId] : []),
				...state.mru.filter(id => id !== next.tabId && open.has(id)),
			];
			for (const tab of tabs) if (!mru.includes(tab.id)) mru.push(tab.id);
			if (navigating || sameEntry(next, last)) return { mru };
			return { mru, back: [...state.back, last].slice(-HISTORY_LIMIT), forward: [] };
		});
		last = next;
	};
	const unsubscribeTabs = useTabsStore.subscribe((next, previous) => {
		if (next.activeTabId !== previous.activeTabId || next.tabs !== previous.tabs) record();
	});
	const unsubscribeUi = useUiStore.subscribe((next, previous) => {
		if (next.destination !== previous.destination) record();
	});
	return () => {
		unsubscribeTabs();
		unsubscribeUi();
	};
}

/** Whether an entry can still be shown: its tab (if any) is open. */
function reachable(entry: HistoryEntry): boolean {
	return entry.tabId === null || useTabsStore.getState().tabs.some(tab => tab.id === entry.tabId);
}

async function apply(entry: HistoryEntry): Promise<void> {
	navigating = true;
	try {
		const ui = useUiStore.getState();
		if (entry.destination === "session") ui.closeDestination();
		else ui.openDestination(entry.destination);
		const tabs = useTabsStore.getState();
		if (entry.tabId && entry.tabId !== tabs.activeTabId) await tabs.switchTab(entry.tabId);
	} finally {
		navigating = false;
	}
}

/** Step back (`-1`) or forward (`1`); false when there is nowhere to go. */
export async function navigateHistory(direction: -1 | 1): Promise<boolean> {
	const state = useTabHistoryStore.getState();
	const from = direction < 0 ? [...state.back] : [...state.forward];
	const here = currentEntry();
	let target: HistoryEntry | undefined;
	while (from.length > 0) {
		const candidate = direction < 0 ? from.pop() : from.shift();
		if (candidate && reachable(candidate) && !sameEntry(candidate, here)) {
			target = candidate;
			break;
		}
	}
	if (!target) {
		useTabHistoryStore.setState(direction < 0 ? { back: from } : { forward: from });
		return false;
	}
	useTabHistoryStore.setState(
		direction < 0
			? { back: from, forward: [here, ...state.forward] }
			: { forward: from, back: [...state.back, here].slice(-HISTORY_LIMIT) },
	);
	await apply(target);
	return true;
}
