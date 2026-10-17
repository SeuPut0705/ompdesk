/**
 * Mobile web (Settings › Devices & connections › Mobile web): the main-owned `MobileWebState`, the connected
 * devices and the blocked ones, mirrored for the renderer. Main is the source of truth — every command answers
 * with the whole new state and `mobile-web:state` / `mobile-web:devices-changed` carry the rest (a block added or
 * lifted also pushes the devices, which is when the blocks are read again) — so this store only holds the latest
 * snapshots. Settings subscribes only while its page is mounted (`useMobileWebSync`), and tells main so
 * (`watch`), which polls Tailscale faster meanwhile.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { MobileWebRequest, MobileWebState, WebBlockedInfo, WebDeviceInfo } from "../../shared/mobile-web";
import { toastError } from "./toast";

export interface MobileWebStore {
	/** Latest snapshot; null until the first read (or push) lands. */
	state: MobileWebState | null;
	/** Connected devices; null until the first read. */
	devices: WebDeviceInfo[] | null;
	/** Blocked devices (or logins); null until the first read. */
	blocked: WebBlockedInfo[] | null;
	/** The first `getState()` failed and nothing has arrived since. */
	loadError: unknown;
	/** Bumped by every state push or reply; a read started before one must not overwrite it. */
	revision: number;
	devicesRevision: number;
	applyState: (state: MobileWebState) => void;
	applyDevices: (devices: WebDeviceInfo[]) => void;
	applyBlocked: (blocked: WebBlockedInfo[]) => void;
	setLoadError: (error: unknown) => void;
	reset: () => void;
}

export const useMobileWebStore = create<MobileWebStore>()(set => ({
	state: null,
	devices: null,
	blocked: null,
	loadError: null,
	revision: 0,
	devicesRevision: 0,
	applyState: state => set(current => ({ state, loadError: null, revision: current.revision + 1 })),
	applyDevices: (devices: WebDeviceInfo[]) =>
		set(current => ({ devices, devicesRevision: current.devicesRevision + 1 })),
	applyBlocked: blocked => set({ blocked }),
	setLoadError: error => set({ loadError: error }),
	reset: () => set({ state: null, devices: null, blocked: null, loadError: null, revision: 0, devicesRevision: 0 }),
}));

/** Read the state, the devices and the blocks from main; a push that lands meanwhile wins over the reply. */
export async function loadMobileWeb(): Promise<void> {
	const { revision, devicesRevision } = useMobileWebStore.getState();
	const [state, devices, blocked] = await Promise.allSettled([
		window.omp.mobileWeb.getState(),
		window.omp.mobileWeb.devices.list(),
		window.omp.mobileWeb.devices.blocked(),
	]);
	const store = useMobileWebStore.getState();
	if (state.status === "fulfilled") {
		if (store.revision === revision) store.applyState(state.value);
	} else if (store.revision === revision) {
		store.setLoadError(state.reason);
	}
	if (devices.status === "fulfilled" && store.devicesRevision === devicesRevision) store.applyDevices(devices.value);
	if (blocked.status === "fulfilled") store.applyBlocked(blocked.value);
}

/** Send one request; the reply is the new state, a failure is a toast. */
export async function mobileWebCommand(request: MobileWebRequest, failureTitle: string): Promise<void> {
	try {
		useMobileWebStore.getState().applyState(await window.omp.mobileWeb.command(request));
	} catch (error) {
		toastError({ title: failureTitle, error });
	}
}

/** Apply a device mutation's reply (the whole new list), or toast why it failed. */
export async function mobileWebDeviceAction(
	action: () => Promise<WebDeviceInfo[]>,
	failureTitle: string,
): Promise<boolean> {
	try {
		useMobileWebStore.getState().applyDevices(await action());
		return true;
	} catch (error) {
		toastError({ title: failureTitle, error });
		return false;
	}
}

/** Lift a block: the reply is the new list of blocks, and the device may connect again; a failure is a toast. */
export async function mobileWebUnblock(blockId: string, failureTitle: string): Promise<boolean> {
	try {
		useMobileWebStore.getState().applyBlocked(await window.omp.mobileWeb.devices.unblock(blockId));
		return true;
	} catch (error) {
		toastError({ title: failureTitle, error });
		return false;
	}
}

/**
 * While Settings › Mobile web is mounted: the first read, both subscriptions and `watch` (main polls Tailscale
 * every 2 s instead of 15 s). Unmounting only stops watching.
 */
export function useMobileWebSync(): void {
	useEffect(() => {
		const api = window.omp.mobileWeb;
		const offState = api.onState(state => useMobileWebStore.getState().applyState(state));
		const offDevices = api.devices.onChanged(devices => {
			useMobileWebStore.getState().applyDevices(devices);
			void api.devices.blocked().then(
				blocked => useMobileWebStore.getState().applyBlocked(blocked),
				() => {},
			);
		});
		void loadMobileWeb();
		void api.command({ action: "watch", on: true }).then(
			state => useMobileWebStore.getState().applyState(state),
			() => {},
		);
		return () => {
			offState();
			offDevices();
			void api.command({ action: "watch", on: false }).catch(() => {});
		};
	}, []);
}
