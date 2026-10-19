/**
 * The left sidebar's fold state, remembered (device-local pref `sidebarFolds`, mirrored in localStorage:
 * `lib/sidebar-memory.ts`): which project / folder / worktree groups are folded, the device sections (this device and
 * each paired host) and their folder groups, the Code/Chat lane the user picked, the Archived section, the Get started
 * checklist and the footer usage block. The sidebar's own components read and write it; the sidebar prunes it
 * (`pruneGroups`, `syncHosts`) once a live read says which folders and hosts still exist.
 */
import { create } from "zustand";
import {
	deviceGroupKey,
	EMPTY_FOLDS,
	type KnownHost,
	LOCAL_DEVICE,
	parseSidebarFolds,
	readSavedPref,
	readSidebarFolds,
	SIDEBAR_FOLDS_PREF,
	type SidebarFolds,
	type SidebarLane,
	withFlag,
	writeSidebarFolds,
} from "../lib/sidebar-memory";

interface SidebarFoldsStore extends SidebarFolds {
	/** An edit happened: a pref read that lands later must not replace it. */
	touched: boolean;
	setGroupFolded: (cwd: string, folded: boolean) => void;
	setDeviceFolded: (deviceId: string, folded: boolean) => void;
	setDeviceGroupFolded: (deviceId: string, cwd: string, folded: boolean) => void;
	setLane: (lane: SidebarLane) => void;
	setArchivedOpen: (open: boolean) => void;
	setStarterOpen: (open: boolean) => void;
	setUsageCollapsed: (collapsed: boolean) => void;
	/** Remembers the device sections' order (top first). */
	setDeviceOrder: (order: readonly string[]) => void;
	/** Drops the folds of groups `exists` refuses. Call only once the folders are known (a live read answered). */
	pruneGroups: (exists: (cwd: string) => boolean) => void;
	/**
	 * Takes the host list a read just gave: remembers it for the next first frame and drops the folds and order entries
	 * of hosts it no longer names (this device always stays). Call only once the host list has loaded.
	 */
	syncHosts: (hosts: readonly KnownHost[]) => void;
	/** Reads the saved pref once; the mirror painted the first frame, the pref wins when it differs. */
	hydrate: () => Promise<void>;
	reset: () => void;
}

function saved(state: SidebarFolds): SidebarFolds {
	return {
		groups: state.groups,
		devices: state.devices,
		deviceGroups: state.deviceGroups,
		lane: state.lane,
		archivedOpen: state.archivedOpen,
		starterOpen: state.starterOpen,
		usageCollapsed: state.usageCollapsed,
		deviceOrder: state.deviceOrder,
		knownHosts: state.knownHosts,
	};
}

export const useSidebarFolds = create<SidebarFoldsStore>()((set, get) => {
	/** Applies an edit and remembers it. */
	const edit = (patch: Partial<SidebarFolds>) => {
		set({ ...patch, touched: true });
		writeSidebarFolds(saved(get()));
	};
	return {
		...readSidebarFolds(),
		touched: false,
		setGroupFolded: (cwd, folded) => edit({ groups: withFlag(get().groups, cwd, folded) }),
		setDeviceFolded: (deviceId, folded) => edit({ devices: withFlag(get().devices, deviceId, folded) }),
		setDeviceGroupFolded: (deviceId, cwd, folded) =>
			edit({ deviceGroups: withFlag(get().deviceGroups, deviceGroupKey(deviceId, cwd), folded) }),
		setLane: lane => {
			if (get().lane !== lane) edit({ lane });
		},
		setArchivedOpen: open => {
			if (get().archivedOpen !== open) edit({ archivedOpen: open });
		},
		setStarterOpen: open => {
			if (get().starterOpen !== open) edit({ starterOpen: open });
		},
		setUsageCollapsed: collapsed => {
			if (get().usageCollapsed !== collapsed) edit({ usageCollapsed: collapsed });
		},
		setDeviceOrder: order => {
			if (order.join("\n") !== get().deviceOrder.join("\n")) edit({ deviceOrder: [...order] });
		},
		pruneGroups: exists => {
			const { groups } = get();
			const kept = Object.entries(groups).filter(([cwd]) => exists(cwd));
			if (kept.length === Object.keys(groups).length) return;
			set({ groups: Object.fromEntries(kept) });
			writeSidebarFolds(saved(get()));
		},
		syncHosts: hosts => {
			const { devices, deviceGroups, deviceOrder, knownHosts } = get();
			const ids = new Set(hosts.map(host => host.id));
			const known = (deviceId: string) => deviceId === LOCAL_DEVICE || ids.has(deviceId);
			const keptDevices = Object.entries(devices).filter(([deviceId]) => known(deviceId));
			const keptGroups = Object.entries(deviceGroups).filter(([key]) => known(key.slice(0, key.indexOf("\n"))));
			const keptOrder = deviceOrder.filter(known);
			if (
				keptDevices.length === Object.keys(devices).length &&
				keptGroups.length === Object.keys(deviceGroups).length &&
				keptOrder.length === deviceOrder.length &&
				JSON.stringify(hosts) === JSON.stringify(knownHosts)
			)
				return;
			set({
				devices: Object.fromEntries(keptDevices),
				deviceGroups: Object.fromEntries(keptGroups),
				deviceOrder: keptOrder,
				knownHosts: [...hosts],
			});
			writeSidebarFolds(saved(get()));
		},
		hydrate: async () => {
			const value = await readSavedPref(SIDEBAR_FOLDS_PREF);
			if (value === null || get().touched) return;
			const folds = parseSidebarFolds(value);
			set(folds);
			writeSidebarFolds(folds);
		},
		reset: () => set({ ...EMPTY_FOLDS, touched: false }),
	};
});
