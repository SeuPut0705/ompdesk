import { createStore } from "zustand/vanilla";
import type { ExtensionUIRequest } from "../../shared/rpc-types";
import { createScopedStoreHook } from "./session-runtime-context";

export interface ExtensionUiSnapshot {
	pendingRequests: ExtensionUIRequest[];
	statusWidgets: Record<string, string>;
	widgetPanels: Record<string, string[]>;
}

export interface ExtensionUiStore extends ExtensionUiSnapshot {
	pushRequest: (request: ExtensionUIRequest) => void;
	removeRequest: (id: string) => void;
	setStatus: (key: string, text: string | undefined) => void;
	setWidget: (key: string, lines: string[] | undefined) => void;
	clearAll: () => void;
}

/** Pure request reducer shared by the visible store and parked tab bundles. */
export function applyExtensionUiRequest(
	snapshot: ExtensionUiSnapshot,
	request: ExtensionUIRequest,
): ExtensionUiSnapshot {
	if (request.method === "setStatus") {
		const statusWidgets = { ...snapshot.statusWidgets };
		if (request.statusText) statusWidgets[request.statusKey] = request.statusText;
		else delete statusWidgets[request.statusKey];
		return { ...snapshot, statusWidgets };
	}
	if (request.method === "setWidget") {
		const widgetPanels = { ...snapshot.widgetPanels };
		if (request.widgetLines && request.widgetLines.length > 0) widgetPanels[request.widgetKey] = request.widgetLines;
		else delete widgetPanels[request.widgetKey];
		return { ...snapshot, widgetPanels };
	}
	if (request.method === "cancel") {
		return { ...snapshot, pendingRequests: snapshot.pendingRequests.filter(item => item.id !== request.targetId) };
	}
	return { ...snapshot, pendingRequests: [...snapshot.pendingRequests, request] };
}

export const createExtensionUiStore = () =>
	createStore<ExtensionUiStore>()((set, get) => ({
		pendingRequests: [],
		statusWidgets: {},
		widgetPanels: {},
		pushRequest: request => set(state => applyExtensionUiRequest(state, request)),
		removeRequest: id => set({ pendingRequests: get().pendingRequests.filter(r => r.id !== id) }),
		setStatus: (key, text) => {
			const next = { ...get().statusWidgets };
			if (text) {
				next[key] = text;
			} else {
				delete next[key];
			}
			set({ statusWidgets: next });
		},
		setWidget: (key, lines) => {
			const next = { ...get().widgetPanels };
			if (lines && lines.length > 0) {
				next[key] = lines;
			} else {
				delete next[key];
			}
			set({ widgetPanels: next });
		},
		clearAll: () => set({ pendingRequests: [], statusWidgets: {}, widgetPanels: {} }),
	}));

const defaultExtensionUiStore = createExtensionUiStore();
export const useExtensionUiStore = createScopedStoreHook("extensionUi", defaultExtensionUiStore);
