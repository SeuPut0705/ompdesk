import { createStore, type StoreApi } from "zustand/vanilla";
import type { AutopilotStatus } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import { createScopedStoreHook, sessionRuntimeStore } from "./session-runtime-context";

/** Commits the autopilot branch is ahead of / behind the branch it was cut from (`autopilot_branch_status`). */
export interface AutopilotBranchStatus {
	ahead: number;
	behind: number;
}

/**
 * One tab's Autopilot run: the whole `AutopilotStatus` of `get_autopilot` / the `autopilot_update` frame. The screen,
 * the work board card and the composer chip derive everything from it and from the stores they already read
 * (tools, todo, tabs); nothing here is computed state.
 */
export interface AutopilotStore {
	status: AutopilotStatus;
	/** A status arrived (hydration or a frame); until then the tab is not known to be a run. */
	hydrated: boolean;
	/** Counts the frames and hydrations applied, so a slower hydration read never overwrites a newer frame. */
	version: number;
	branchStatus: AutopilotBranchStatus | null;
	/** A frame (or a hydration read) replaced the status. */
	apply: (status: AutopilotStatus) => void;
	/** A hydration read replaces the status only when no frame landed since it started (`startedAt` = `version` then). */
	hydrateIfCurrent: (startedAt: number, status: AutopilotStatus) => boolean;
	setBranchStatus: (branchStatus: AutopilotBranchStatus | null) => void;
	reset: () => void;
}

const NO_RUN: AutopilotStatus = { active: false };

/** Whether this tab is (or was) an Autopilot run: its screen exists. A live run is `isLiveAutopilot`. */
export function isAutopilotTab(state: Pick<AutopilotStore, "status">): boolean {
	return state.status.active;
}

/** A run that has not ended: it can still produce cycles, or be resumed. */
export function isLiveAutopilot(state: Pick<AutopilotStore, "status">): boolean {
	return state.status.active && state.status.state !== undefined && state.status.state !== "ended";
}

export const createAutopilotStore = () =>
	createStore<AutopilotStore>()((set, get) => ({
		status: NO_RUN,
		hydrated: false,
		version: 0,
		branchStatus: null,
		apply: status => set({ status, hydrated: true, version: get().version + 1 }),
		hydrateIfCurrent: (startedAt, status) => {
			if (get().version !== startedAt) return false;
			set({ status, hydrated: true, version: startedAt + 1 });
			return true;
		},
		setBranchStatus: branchStatus => set({ branchStatus }),
		reset: () => set({ status: NO_RUN, hydrated: false, version: 0, branchStatus: null }),
	}));

const defaultAutopilotStore = createAutopilotStore();
export const useAutopilotStore = createScopedStoreHook("autopilot", defaultAutopilotStore);

/** One tab's store by id (an async continuation must not follow the focus); the focused-runtime fallback outside a tab. */
export function tabAutopilotStore(tabId: string | null): StoreApi<AutopilotStore> {
	return sessionRuntimeStore<AutopilotStore>(tabId, "autopilot") ?? defaultAutopilotStore;
}
