/**
 * Remote devices (Settings › Remote devices, sidebar device sections, device
 * chips): the main-owned `RemoteState` mirrored for the renderer. Main is the
 * source of truth — every mutation answers with the whole new state and the
 * `remote:state` push carries every other change, so this store only holds
 * the latest snapshot plus how its first read went.
 */
import { useEffect, useReducer } from "react";
import { create } from "zustand";
import type { HostView, RemoteState } from "../../shared/ipc-types";
import { LINK_NOTICE_GRACE_MS } from "../../shared/link-notice";
import { focusedRuntimeTabId, useRuntimeTabId } from "./session-runtime-context";
import { useTabsStore } from "./tabs";

export interface RemoteStore {
	/** Latest snapshot; null until the first read (or push) lands. */
	state: RemoteState | null;
	/** The last `getState()` failed and nothing has arrived since. */
	loadError: unknown;
	/** Bumped by every push; a read started before a push must not overwrite it. */
	revision: number;
	/** `trackDown`: when each not-online host was first seen down. */
	downSince: Readonly<Record<string, number>>;
	apply: (state: RemoteState) => void;
	setLoadError: (error: unknown) => void;
	reset: () => void;
}

const EMPTY_HOSTS: readonly HostView[] = [];

export const useRemoteStore = create<RemoteStore>()(set => ({
	state: null,
	loadError: null,
	revision: 0,
	downSince: {},
	apply: state =>
		set(current => ({
			state,
			loadError: null,
			revision: current.revision + 1,
			downSince: trackDown(current.downSince, state.hosts),
		})),
	setLoadError: error => set({ loadError: error }),
	reset: () => set({ state: null, loadError: null, revision: 0, downSince: {} }),
}));

/** Read the whole state from main; a push that lands meanwhile wins over the reply. */
export async function loadRemoteState(): Promise<void> {
	const store = useRemoteStore.getState();
	const revision = store.revision;
	try {
		const state = await window.omp.remote.getState();
		if (useRemoteStore.getState().revision === revision) useRemoteStore.getState().apply(state);
	} catch (error) {
		if (useRemoteStore.getState().revision === revision) useRemoteStore.getState().setLoadError(error);
	}
}

/** Boot wiring (App): the first read plus the `remote:state` subscription, once per window. */
export function useRemoteStateSync(): void {
	useEffect(() => {
		const unsubscribe = window.omp.remote.onState(state => useRemoteStore.getState().apply(state));
		void loadRemoteState();
		return unsubscribe;
	}, []);
}

/** Paired hosts (A role); empty until the first read, so the sidebar stays as it was. */
export function usePairedHosts(): readonly HostView[] {
	return useRemoteStore(store => store.state?.hosts ?? EMPTY_HOSTS);
}

/** One paired host by deviceId; undefined for local tabs and for hosts that were removed. */
export function useHostView(deviceId: string | undefined): HostView | undefined {
	return useRemoteStore(store =>
		deviceId === undefined ? undefined : store.state?.hosts.find(host => host.deviceId === deviceId),
	);
}

/** When each host that is not online was first seen so (ms); a host that is online has no entry. */
function trackDown(previous: Readonly<Record<string, number>>, hosts: readonly HostView[]): Record<string, number> {
	const now = Date.now();
	const next: Record<string, number> = {};
	for (const host of hosts) if (host.state !== "online") next[host.deviceId] = previous[host.deviceId] ?? now;
	return next;
}

/**
 * True once the host's link has stayed down for `LINK_NOTICE_GRACE_MS`, counted from when this window first
 * saw it down (a tab opened later in a long outage shows at once). False before the device list has loaded,
 * for a host that is online or was removed, and for a drop that heals inside the grace.
 */
export function useHostLinkLost(deviceId: string | undefined): boolean {
	const since = useRemoteStore(store => (deviceId === undefined ? undefined : store.downSince[deviceId]));
	const [, wake] = useReducer((count: number) => count + 1, 0);
	useEffect(() => {
		if (since === undefined) return;
		const left = since + LINK_NOTICE_GRACE_MS - Date.now();
		if (left <= 0) return;
		const timer = setTimeout(wake, left);
		return () => clearTimeout(timer);
	}, [since]);
	return since !== undefined && Date.now() - since >= LINK_NOTICE_GRACE_MS;
}

/** Paired host the window's focused tab runs on (pane-scoped inside a session pane); undefined = this device. */
export function useFocusedTabDevice(): string | undefined {
	const tabId = useRuntimeTabId();
	return useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.device);
}

/** Non-hook read for imperative callers (menu actions, the command registry, picker helpers). */
export function focusedTabDevice(): string | undefined {
	const tabId = focusedRuntimeTabId();
	return useTabsStore.getState().tabs.find(tab => tab.id === tabId)?.device;
}

/** The paired host the focused tab runs on, as Settings/Usage/Stats scope to it. */
export interface FocusedHost {
	deviceId: string;
	/** Undefined while the remote state is loading or after the host was removed. */
	name: string | undefined;
	/** Only an online host's data is shown; anything else is offline, never stale or local. */
	online: boolean;
}

/** The focused tab's paired host; undefined when the focused tab runs on this device. */
export function useFocusedHost(): FocusedHost | undefined {
	const deviceId = useFocusedTabDevice();
	const host = useHostView(deviceId);
	if (deviceId === undefined) return undefined;
	return { deviceId, name: host?.name, online: host?.state === "online" };
}

interface RemotePickerRequest {
	deviceId: string;
	resolve: (path: string | undefined) => void;
}

/** The one open remote folder picker (`RemoteFolderPickerHost` renders it). */
export const useRemotePickerStore = create<{ request: RemotePickerRequest | null }>()(() => ({ request: null }));

/** Settle the open picker request with the chosen folder (undefined = cancelled). */
export function settleRemoteDirectory(path: string | undefined): void {
	const request = useRemotePickerStore.getState().request;
	useRemotePickerStore.setState({ request: null });
	request?.resolve(path);
}

/**
 * Browse a paired host's folders (the native dialog only sees this device);
 * resolves the chosen absolute path on the host, or undefined when cancelled.
 * A newer request cancels an open one.
 */
export function pickRemoteDirectory(deviceId: string): Promise<string | undefined> {
	settleRemoteDirectory(undefined);
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	useRemotePickerStore.setState({ request: { deviceId, resolve } });
	return promise;
}
