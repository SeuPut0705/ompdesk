import { createStore } from "zustand/vanilla";
import { BLOCKING_UI_METHODS, type ExtensionUIRequest } from "../../shared/rpc-types";
import { createScopedStoreHook } from "./session-runtime-context";

export interface ExtensionUiSnapshot {
	pendingRequests: ExtensionUIRequest[];
	statusWidgets: Record<string, string>;
	widgetPanels: Record<string, string[]>;
}

export interface ExtensionUiStore extends ExtensionUiSnapshot {
	/**
	 * A provider sign-in rendered inline (providers list, first-run setup) is in
	 * flight: its `open_url` / `input` requests belong to that surface, so the
	 * global ExtensionDialog leaves them alone.
	 */
	inlineLogin: boolean;
	setInlineLogin: (active: boolean) => void;
	pushRequest: (request: ExtensionUIRequest) => void;
	removeRequest: (id: string) => void;
	setStatus: (key: string, text: string | undefined) => void;
	setWidget: (key: string, lines: string[] | undefined) => void;
	clearAll: () => void;
}

/** Requests an inline provider sign-in answers itself. */
export function isInlineLoginRequest(request: ExtensionUIRequest): boolean {
	return request.method === "open_url" || request.method === "input";
}

/**
 * The session blocks on the user: a response-bearing request is pending. A
 * provider sign-in answered inline is the user's own action, not the session
 * waiting on them.
 */
export function awaitsUserInput(state: Pick<ExtensionUiStore, "pendingRequests" | "inlineLogin">): boolean {
	return state.pendingRequests.some(
		request => BLOCKING_UI_METHODS[request.method] === true && !(state.inlineLogin && isInlineLoginRequest(request)),
	);
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
		inlineLogin: false,
		setInlineLogin: active => set({ inlineLogin: active }),
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
