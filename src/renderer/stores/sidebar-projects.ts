/**
 * The sidebar's project lists (contract `src/shared/sidebar-projects.ts`), one per computer: this computer's
 * (`LOCAL_DEVICE`) and each paired host's own, which the host keeps and pushes. The sidebar paints the last read at
 * its first frame (`lib/last-read.ts`) and the live read replaces it in place.
 */
import { useEffect } from "react";
import { create } from "zustand";
import {
	EMPTY_SIDEBAR_PROJECTS,
	parseSidebarProjects,
	type SidebarProjectsRequest,
	type SidebarProjectsState,
} from "../../shared/sidebar-projects";
import { translate } from "../lib/i18n";
import { lastRead, rememberRead } from "../lib/last-read";
import { LOCAL_DEVICE } from "../lib/sidebar-memory";
import { toastError } from "./toast";

const SNAPSHOT_KEY = "sidebar-projects";

interface SidebarProjectsStore {
	/** By device (`LOCAL_DEVICE` for this computer). */
	lists: Record<string, SidebarProjectsState>;
	/** Read (again) a computer's list: at mount, and for a host each time its link comes up. */
	load: (device?: string) => void;
	/** The person opened a folder there: it joins the list (a worktree as its project), removed before or not. */
	add: (device: string | undefined, path: string) => void;
	/** "Remove from sidebar": its sessions stay, listed under no project. */
	remove: (device: string | undefined, path: string) => Promise<void>;
	reset: () => void;
}

const keyOf = (device: string | undefined) => device ?? LOCAL_DEVICE;

function cached(device: string | undefined): SidebarProjectsState | undefined {
	const value = lastRead<unknown>(device, SNAPSHOT_KEY);
	return value === undefined ? undefined : parseSidebarProjects(value);
}

export const useSidebarProjects = create<SidebarProjectsStore>((set, get) => {
	const apply = (device: string | undefined, state: SidebarProjectsState) => {
		rememberRead(device, SNAPSHOT_KEY, state);
		set(current => ({ lists: { ...current.lists, [keyOf(device)]: state } }));
	};
	const run = (device: string | undefined, request: SidebarProjectsRequest) =>
		window.omp.sidebarProjects.command(request, device).then(state => apply(device, parseSidebarProjects(state)));
	return {
		lists: {},
		load: device => {
			if (!window.omp?.sidebarProjects) return;
			if (get().lists[keyOf(device)] === undefined) {
				const seed = cached(device);
				if (seed) set(current => ({ lists: { ...current.lists, [keyOf(device)]: seed } }));
			}
			// A list that cannot be read keeps what was known; the sidebar still groups by sessions meanwhile.
			void run(device, { action: "get" }).catch(() => undefined);
		},
		add: (device, path) => {
			if (!path || !window.omp?.sidebarProjects) return;
			void run(device, { action: "add", path }).catch(() => undefined);
		},
		remove: async (device, path) => {
			const before = get().lists[keyOf(device)] ?? EMPTY_SIDEBAR_PROJECTS;
			// The row leaves at once; a refused write puts it back.
			apply(device, {
				...before,
				projects: before.projects.filter(entry => entry.path !== path),
				removed: [...before.removed.filter(entry => entry !== path), path],
			});
			try {
				await run(device, { action: "remove", path });
			} catch (error) {
				apply(device, before);
				toastError({ title: translate("sidebar.removeProjectFailed"), error });
			}
		},
		reset: () => set({ lists: {} }),
	};
});

/** One subscription to every computer's pushed list while any sidebar list is mounted. */
let followers = 0;
let unfollow: (() => void) | null = null;

function follow(): () => void {
	followers += 1;
	unfollow ??=
		window.omp?.sidebarProjects?.onState(update =>
			useSidebarProjects.setState(current => {
				const state = parseSidebarProjects(update.state);
				rememberRead(update.device, SNAPSHOT_KEY, state);
				return { lists: { ...current.lists, [keyOf(update.device)]: state } };
			}),
		) ?? null;
	return () => {
		followers -= 1;
		if (followers > 0) return;
		unfollow?.();
		unfollow = null;
	};
}

/**
 * A computer's list (empty until known), read at mount and, for a paired host, each time `read` turns on (its link
 * came up: changes it pushed while away were missed).
 */
export function useProjectList(device?: string, read = true): SidebarProjectsState {
	useEffect(follow, []);
	useEffect(() => {
		if (read) useSidebarProjects.getState().load(device);
	}, [device, read]);
	return useSidebarProjects(state => state.lists[keyOf(device)] ?? EMPTY_SIDEBAR_PROJECTS);
}
