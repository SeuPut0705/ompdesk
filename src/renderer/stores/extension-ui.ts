import { createStore } from "zustand/vanilla";
import { BLOCKING_UI_METHODS, type ExtensionUIRequest } from "../../shared/rpc-types";
import { createScopedStoreHook } from "./session-runtime-context";

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionUiSnapshot {
	pendingRequests: ExtensionUIRequest[];
	/**
	 * When each pending request reached this window (ms). Stock starts a
	 * dialog's timeout when it sends the request (rpc-mode `requestRpcDialog`),
	 * so a request queued behind another has already spent part of it.
	 */
	arrivedAt: Record<string, number>;
	statusWidgets: Record<string, string>;
	widgetPanels: Record<string, string[]>;
	/** Placement of each widget in `widgetPanels`; stock's default is above the editor. */
	widgetPlacements: Record<string, WidgetPlacement>;
	/** The extension's `setTitle`, kept per tab so a background tab's title returns with it. */
	title: string | null;
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
	clearAll: () => void;
}

/** Requests an inline provider sign-in answers itself. */
export function isInlineLoginRequest(request: ExtensionUIRequest): boolean {
	return request.method === "open_url" || request.method === "input";
}

/**
 * The address to open for an `open_url` request. `launchUrl` is served by the
 * OAuth callback server on the machine running omp (`http://localhost:<port>/launch`),
 * so a tab on a paired host opens the provider's own `url` instead: this
 * device's localhost is not the host's.
 */
export function openUrlTarget(request: Extract<ExtensionUIRequest, { method: "open_url" }>, remote: boolean): string {
	return remote ? request.url : (request.launchUrl ?? request.url);
}

/**
 * Tool approval reaches the GUI as a plain `select` with exactly
 * ["Approve", "Deny"] and a title "Allow tool: <name>\n<details>".
 */
export const APPROVAL_TITLE_PREFIX = "Allow tool: ";

export type ApprovalSelect = Extract<ExtensionUIRequest, { method: "select" }>;

export function isApprovalRequest(request: ExtensionUIRequest): request is ApprovalSelect {
	return (
		request.method === "select" &&
		request.options.length === 2 &&
		request.options[0] === "Approve" &&
		request.options[1] === "Deny" &&
		request.title.startsWith(APPROVAL_TITLE_PREFIX)
	);
}

/** What a session blocked on the user waits for: a real approval, or any other answer. */
export type AwaitedInput = "approval" | "input";

/**
 * The session blocks on the user when a response-bearing request is pending;
 * the first such request decides whether that is an approval. A provider
 * sign-in answered inline is the user's own action, not the session waiting
 * on them.
 */
export function awaitedInput(state: Pick<ExtensionUiStore, "pendingRequests" | "inlineLogin">): AwaitedInput | null {
	const blocking = state.pendingRequests.find(
		request => BLOCKING_UI_METHODS[request.method] === true && !(state.inlineLogin && isInlineLoginRequest(request)),
	);
	if (!blocking) return null;
	return isApprovalRequest(blocking) ? "approval" : "input";
}

/** Pure request reducer shared by the visible store and parked tab bundles. */
export function applyExtensionUiRequest(
	snapshot: ExtensionUiSnapshot,
	request: ExtensionUIRequest,
	now: number,
): ExtensionUiSnapshot {
	if (request.method === "setStatus") {
		const statusWidgets = { ...snapshot.statusWidgets };
		if (request.statusText) statusWidgets[request.statusKey] = request.statusText;
		else delete statusWidgets[request.statusKey];
		return { ...snapshot, statusWidgets };
	}
	if (request.method === "setWidget") {
		const widgetPanels = { ...snapshot.widgetPanels };
		const widgetPlacements = { ...snapshot.widgetPlacements };
		if (request.widgetLines && request.widgetLines.length > 0) {
			widgetPanels[request.widgetKey] = request.widgetLines;
			widgetPlacements[request.widgetKey] =
				request.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor";
		} else {
			delete widgetPanels[request.widgetKey];
			delete widgetPlacements[request.widgetKey];
		}
		return { ...snapshot, widgetPanels, widgetPlacements };
	}
	if (request.method === "setTitle") return { ...snapshot, title: request.title };
	if (request.method === "cancel") return withoutRequest(snapshot, request.targetId);
	return {
		...snapshot,
		pendingRequests: [...snapshot.pendingRequests, request],
		arrivedAt: { ...snapshot.arrivedAt, [request.id]: now },
	};
}

function withoutRequest(snapshot: ExtensionUiSnapshot, id: string): ExtensionUiSnapshot {
	const arrivedAt = { ...snapshot.arrivedAt };
	delete arrivedAt[id];
	return { ...snapshot, pendingRequests: snapshot.pendingRequests.filter(item => item.id !== id), arrivedAt };
}

const EMPTY_SNAPSHOT: ExtensionUiSnapshot = {
	pendingRequests: [],
	arrivedAt: {},
	statusWidgets: {},
	widgetPanels: {},
	widgetPlacements: {},
	title: null,
};

export const createExtensionUiStore = () =>
	createStore<ExtensionUiStore>()((set, get) => ({
		...EMPTY_SNAPSHOT,
		inlineLogin: false,
		setInlineLogin: active => set({ inlineLogin: active }),
		pushRequest: request => set(state => applyExtensionUiRequest(state, request, Date.now())),
		removeRequest: id => set(withoutRequest(get(), id)),
		clearAll: () => set(EMPTY_SNAPSHOT),
	}));

const defaultExtensionUiStore = createExtensionUiStore();
export const useExtensionUiStore = createScopedStoreHook("extensionUi", defaultExtensionUiStore);
