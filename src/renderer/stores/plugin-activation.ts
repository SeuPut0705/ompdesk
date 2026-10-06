import { create } from "zustand";

export interface PluginActivationTarget {
	pluginId: string;
	expected: "enabled" | "disabled";
}

export interface PendingPluginActivation {
	sessionId: string | null;
	targets: PluginActivationTarget[];
}

interface PluginActivationStore {
	pendingByTab: Readonly<Record<string, PendingPluginActivation>>;
	requestActivation: (target: PluginActivationTarget, tabId: string, sessionId: string | null) => void;
	takeActivation: (tabId: string) => PendingPluginActivation | null;
	clearActivation: (tabId: string) => void;
	reset: () => void;
}

export const usePluginActivationStore = create<PluginActivationStore>((set, get) => ({
	pendingByTab: {},
	requestActivation: (target, tabId, sessionId) =>
		set(state => {
			const current = state.pendingByTab[tabId];
			const targets =
				current?.sessionId === sessionId
					? [...current.targets.filter(item => item.pluginId !== target.pluginId), target]
					: [target];
			return { pendingByTab: { ...state.pendingByTab, [tabId]: { sessionId, targets } } };
		}),
	takeActivation: tabId => {
		const pending = get().pendingByTab[tabId] ?? null;
		if (!pending) return null;
		set(state => {
			const pendingByTab = { ...state.pendingByTab };
			delete pendingByTab[tabId];
			return { pendingByTab };
		});
		return pending;
	},
	clearActivation: tabId =>
		set(state => {
			if (!(tabId in state.pendingByTab)) return state;
			const pendingByTab = { ...state.pendingByTab };
			delete pendingByTab[tabId];
			return { pendingByTab };
		}),
	reset: () => set({ pendingByTab: {} }),
}));
