import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import { type UseBoundStore, useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { RpcCommand, RpcResponse, RpcResponseError } from "../../shared/rpc-types";

export type RuntimeStoreKey =
	| "autopilot"
	| "composer"
	| "extensionUi"
	| "messages"
	| "model"
	| "planApproval"
	| "queue"
	| "session"
	| "settings"
	| "subagentGraph"
	| "subagents"
	| "todo"
	| "tools";

export type TabCommand = (command: RpcCommand, timeoutMs?: number) => Promise<RpcResponse>;

/** Active-tab fallback for tests and startup races, before a tab runtime exists. */
export function activeTabCommand(command: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
	return window.omp.rpc.command(command, timeoutMs);
}

/**
 * What a tab runtime answers once it no longer speaks for its tab (the tab closed, or its session changed and a new
 * runtime took over): the command never reached the session it was meant for, or its answer belongs to an old one.
 * `data.sessionReplaced` lets a background read tell that from a failure.
 */
export function replacedSessionResponse(command: RpcCommand): RpcResponseError {
	return {
		type: "response",
		command: command.type,
		success: false,
		error: "The originating session was replaced or closed. Refresh this view before retrying.",
		data: { sessionReplaced: true },
	};
}

/** A refusal from a runtime that no longer speaks for its tab: superseded, not failed. */
export function isSessionReplaced(response: RpcResponse): boolean {
	return (
		!response.success &&
		typeof response.data === "object" &&
		response.data !== null &&
		"sessionReplaced" in response.data &&
		response.data.sessionReplaced === true
	);
}

export interface SessionRuntime {
	tabId: string;
	command: TabCommand;
	stores: Map<RuntimeStoreKey, StoreApi<unknown>>;
	/** A process restart may allocate a new ID for an unpersisted session. */
	recovering?: boolean;
}

const SessionRuntimeContext = createContext<SessionRuntime | null>(null);
const runtimes = new Map<string, SessionRuntime>();
const focusedListeners = new Set<() => void>();
let focusedTabId: string | null = null;
let executionTabId: string | null = null;

const registryListeners = new Set<() => void>();
let registryNotifyQueued = false;

/** Runtimes are created mid-render (App, SplitWorkspace): notify after the current task, never synchronously. */
function notifyRegistryChange(): void {
	if (registryNotifyQueued || registryListeners.size === 0) return;
	registryNotifyQueued = true;
	queueMicrotask(() => {
		registryNotifyQueued = false;
		for (const listener of registryListeners) listener();
	});
}

export function registerSessionRuntime(runtime: SessionRuntime): SessionRuntime {
	runtimes.set(runtime.tabId, runtime);
	notifyRegistryChange();
	return runtime;
}

export function sessionRuntime(tabId: string | null): SessionRuntime | null {
	return tabId ? (runtimes.get(tabId) ?? null) : null;
}

export function sessionRuntimeStore<T>(tabId: string | null, key: RuntimeStoreKey): StoreApi<T> | null {
	return (sessionRuntime(tabId)?.stores.get(key) as StoreApi<T> | undefined) ?? null;
}

export function deleteSessionRuntime(tabId: string): void {
	runtimes.delete(tabId);
	notifyRegistryChange();
	if (focusedTabId === tabId) setFocusedSessionRuntime(null);
}

/** Called after a tab's runtime is created, replaced or closed. */
export function onSessionRuntimesChange(listener: () => void): () => void {
	registryListeners.add(listener);
	return () => registryListeners.delete(listener);
}

/**
 * Another tab's runtime (not the nearest provider's), re-rendering when that
 * tab's runtime is created, replaced by a session change, or closed.
 */
export function useTabSessionRuntime(tabId: string | null): SessionRuntime | null {
	const getSnapshot = () => sessionRuntime(tabId);
	return useSyncExternalStore(onSessionRuntimesChange, getSnapshot, getSnapshot);
}

export function setFocusedSessionRuntime(tabId: string | null): void {
	if (focusedTabId === tabId) return;
	focusedTabId = tabId;
	for (const listener of focusedListeners) listener();
}

export function focusedSessionRuntime(): SessionRuntime | null {
	return sessionRuntime(executionTabId) ?? sessionRuntime(focusedTabId);
}

/** Tab id a window-level (non-pane-scoped) action targets. */
export function focusedRuntimeTabId(): string | null {
	return focusedSessionRuntime()?.tabId ?? focusedTabId;
}

/** Scope synchronous event reduction to its originating tab without changing UI focus. */
export function withSessionRuntime<T>(tabId: string, run: () => T): T {
	const previous = executionTabId;
	executionTabId = tabId;
	try {
		return run();
	} finally {
		executionTabId = previous;
	}
}

export function onFocusedSessionRuntimeChange(listener: () => void): () => void {
	focusedListeners.add(listener);
	return () => focusedListeners.delete(listener);
}

export function SessionRuntimeProvider({ runtime, children }: { runtime: SessionRuntime; children: ReactNode }) {
	return <SessionRuntimeContext.Provider value={runtime}>{children}</SessionRuntimeContext.Provider>;
}

export function useSessionRuntime(): SessionRuntime | null {
	return useContext(SessionRuntimeContext);
}

export function useRuntimeTabId(): string | null {
	return useSessionRuntime()?.tabId ?? focusedTabId;
}

export function useTabCommand(): TabCommand {
	const runtime = useSessionRuntime();
	return runtime?.command ?? activeTabCommand;
}

function runtimeStore<T>(runtime: SessionRuntime | null, key: RuntimeStoreKey, fallback: StoreApi<T>): StoreApi<T> {
	return (runtime?.stores.get(key) as StoreApi<T> | undefined) ?? fallback;
}

/**
 * Bind an existing zustand store API to the nearest session runtime. Static
 * `getState`/`setState`/`subscribe` calls follow the focused runtime so legacy
 * window-level actions keep targeting the pane the user most recently focused.
 */
export function createScopedStoreHook<T>(key: RuntimeStoreKey, fallback: StoreApi<T>): UseBoundStore<StoreApi<T>> {
	const useScopedStore = (<U,>(selector?: (state: T) => U): T | U => {
		const store = runtimeStore(useContext(SessionRuntimeContext), key, fallback);
		const select = selector ?? ((state: T) => state as unknown as U);
		return useStore(store, select);
	}) as UseBoundStore<StoreApi<T>>;

	useScopedStore.getState = () => runtimeStore(focusedSessionRuntime(), key, fallback).getState();
	useScopedStore.getInitialState = () => runtimeStore(focusedSessionRuntime(), key, fallback).getInitialState();
	useScopedStore.setState = (partial, replace) => {
		const store = runtimeStore(focusedSessionRuntime(), key, fallback);
		if (replace === true) store.setState(partial as T, true);
		else store.setState(partial);
	};
	useScopedStore.subscribe = listener => {
		let store = runtimeStore(focusedSessionRuntime(), key, fallback);
		let unsubscribe = store.subscribe(listener);
		const stopFollowingFocus = onFocusedSessionRuntimeChange(() => {
			unsubscribe();
			store = runtimeStore(focusedSessionRuntime(), key, fallback);
			// Follow the newly focused store SILENTLY: synthesizing a cross-store
			// (state, previous) pair here would look like a real transition to
			// diffing subscribers (voice auto-speak would re-read the newly focused
			// tab's last message as "new"), and a throwing listener would leave the
			// resubscribe below permanently unexecuted.
			unsubscribe = store.subscribe(listener);
		});
		return () => {
			stopFollowingFocus();
			unsubscribe();
		};
	};
	return useScopedStore;
}

export function addRuntimeStore<T>(runtime: SessionRuntime, key: RuntimeStoreKey, store: StoreApi<T>): void {
	runtime.stores.set(key, store as StoreApi<unknown>);
}
