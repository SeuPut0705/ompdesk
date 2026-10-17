import { create } from "zustand";
import type { DesktopSlotState } from "../../../resources/gui-bridge/desktop-slot-contracts";

/**
 * The desktop slot (resources/gui-bridge/desktop-slot-contracts.ts), mirrored from main: which session drives the
 * computer's desktop and who waits. One per app, not per tab: every tab's indicator reads the same slot. Frames
 * (`desktop_slot_update`) replace the whole state; a boot read (`getDesktopSlot`) only fills in when none landed first.
 */
export interface DesktopSlotStore {
	state: DesktopSlotState;
	/** Counts the updates applied, so a slower hydration read never overwrites a newer frame. */
	version: number;
	/** A frame replaced the state. */
	apply: (state: DesktopSlotState) => void;
	/** A hydration read replaces the state only when no frame landed since it started (`startedAt` = `version` then). */
	hydrateIfCurrent: (startedAt: number, state: DesktopSlotState) => boolean;
	reset: () => void;
}

export const FREE_SLOT: DesktopSlotState = { holder: null, queue: [] };

export const useDesktopSlotStore = create<DesktopSlotStore>()((set, get) => ({
	state: FREE_SLOT,
	version: 0,
	apply: state => set({ state, version: get().version + 1 }),
	hydrateIfCurrent: (startedAt, state) => {
		if (get().version !== startedAt) return false;
		set({ state, version: startedAt + 1 });
		return true;
	},
	reset: () => set({ state: FREE_SLOT, version: 0 }),
}));

/** Whether `value` is a slot state: a host or harness that does not know the slot answers `{}`, which must never render. */
function isSlotState(value: unknown): value is DesktopSlotState {
	return (
		typeof value === "object" &&
		value !== null &&
		"holder" in value &&
		"queue" in value &&
		Array.isArray(value.queue) &&
		(value.holder === null || typeof value.holder === "object")
	);
}

/** Boot read of the slot; a frame that lands while it is in flight wins. */
export async function hydrateDesktopSlot(): Promise<void> {
	const startedAt = useDesktopSlotStore.getState().version;
	try {
		const response = await window.omp.rpc.getDesktopSlot();
		if (response.success && isSlotState(response.data)) {
			useDesktopSlotStore.getState().hydrateIfCurrent(startedAt, response.data);
		}
	} catch {
		// Transient — the next desktop_slot_update frame carries the whole state.
	}
}

/**
 * The tab's 1-based place in the slot's queue, or null when it is not waiting. Selector over primitives, so it
 * is safe to subscribe to.
 */
export function selectDesktopSlotPosition(store: Pick<DesktopSlotStore, "state">, tabId: string | null): number | null {
	if (!tabId) return null;
	const index = store.state.queue.findIndex(session => session.tabId === tabId);
	return index < 0 ? null : index + 1;
}
