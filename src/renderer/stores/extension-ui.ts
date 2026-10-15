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
	/**
	 * Host of the latest `open_url` (a sign-in page). Stock's code-paste request
	 * names no provider, so a paste card outside the login panel names this.
	 */
	lastOpenUrlHost: string | null;
}

export interface ExtensionUiStore extends ExtensionUiSnapshot {
	/**
	 * Provider sign-ins an inline panel (providers list, first-run setup) started
	 * on this tab that stock's `login` RPC has not answered yet. They outlive the
	 * panel: stock keeps its callback server and its code-paste request open
	 * until the login settles, whether or not the panel is still on screen.
	 */
	inlineLogins: number;
	/** Requests that arrived while a sign-in was in flight and belong to it (`isInlineLoginRequest`). */
	loginRequestIds: Record<string, true>;
	beginInlineLogin: () => void;
	/**
	 * One sign-in's `login` RPC answered. When none is left, its requests leave
	 * the queue and come back so the caller can answer them: stock never
	 * closes the code paste it raced against the callback (rpc-mode `login`
	 * passes no signal to its `input`).
	 */
	endInlineLogin: () => ExtensionUIRequest[];
	pushRequest: (request: ExtensionUIRequest) => void;
	removeRequest: (id: string) => void;
	clearAll: () => void;
}

/**
 * Requests stock's `login` sends: the sign-in or key page (`open_url`), the
 * pasted key or code (`input`) and its progress (`onProgress`, info-level
 * `notify`). Warnings and errors still toast.
 */
function isInlineLoginRequest(request: ExtensionUIRequest): boolean {
	if (request.method === "notify") return (request.notifyType ?? "info") === "info";
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
 * Whether `pushRequest` records a request as a provider sign-in's own: it
 * arrives while a sign-in is in flight and has the kind stock's `login` sends.
 * The window's notification listener runs before the store records it, so it
 * asks here too.
 */
export function claimsLoginRequest(
	state: Pick<ExtensionUiStore, "inlineLogins">,
	request: ExtensionUIRequest,
): boolean {
	return state.inlineLogins > 0 && isInlineLoginRequest(request);
}

/**
 * Whether a request is the session waiting on the user: a response-bearing
 * method that is not a provider sign-in's own traffic (`loginRequestIds`).
 * That traffic is answered in the login panel, so it never counts as "needs
 * you" (OS notification, goal strip, island count, sidebar badge).
 */
export function isUserBlockingRequest(
	state: Pick<ExtensionUiStore, "loginRequestIds">,
	request: ExtensionUIRequest,
): boolean {
	return BLOCKING_UI_METHODS[request.method] === true && !Object.hasOwn(state.loginRequestIds, request.id);
}

/**
 * The session blocks on the user when a response-bearing request is pending;
 * the first such request decides whether that is an approval. A provider
 * sign-in answered inline is the user's own action, not the session waiting
 * on them.
 */
export function awaitedInput(
	state: Pick<ExtensionUiStore, "pendingRequests" | "loginRequestIds">,
): AwaitedInput | null {
	const blocking = state.pendingRequests.find(request => isUserBlockingRequest(state, request));
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
	const queued = {
		...snapshot,
		pendingRequests: [...snapshot.pendingRequests, request],
		arrivedAt: { ...snapshot.arrivedAt, [request.id]: now },
	};
	if (request.method !== "open_url") return queued;
	return { ...queued, lastOpenUrlHost: URL.canParse(request.url) ? new URL(request.url).host : null };
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
	lastOpenUrlHost: null,
};

export const createExtensionUiStore = () =>
	createStore<ExtensionUiStore>()((set, get) => ({
		...EMPTY_SNAPSHOT,
		inlineLogins: 0,
		loginRequestIds: {},
		beginInlineLogin: () => set(state => ({ inlineLogins: state.inlineLogins + 1 })),
		endInlineLogin: () => {
			const { inlineLogins, loginRequestIds, pendingRequests, arrivedAt } = get();
			const left = Math.max(0, inlineLogins - 1);
			if (left > 0) {
				set({ inlineLogins: left });
				return [];
			}
			const owned = pendingRequests.filter(request => Object.hasOwn(loginRequestIds, request.id));
			const remainingArrivals = { ...arrivedAt };
			for (const request of owned) delete remainingArrivals[request.id];
			set({
				inlineLogins: 0,
				loginRequestIds: {},
				pendingRequests: pendingRequests.filter(request => !Object.hasOwn(loginRequestIds, request.id)),
				arrivedAt: remainingArrivals,
			});
			return owned;
		},
		pushRequest: request =>
			set(state => {
				const next = applyExtensionUiRequest(state, request, Date.now());
				if (!claimsLoginRequest(state, request)) return next;
				return { ...next, loginRequestIds: { ...state.loginRequestIds, [request.id]: true } };
			}),
		removeRequest: id => set(withoutRequest(get(), id)),
		// The sign-ins themselves run on until stock answers their `login`.
		clearAll: () => set({ ...EMPTY_SNAPSHOT, loginRequestIds: {} }),
	}));

const defaultExtensionUiStore = createExtensionUiStore();
export const useExtensionUiStore = createScopedStoreHook("extensionUi", defaultExtensionUiStore);
