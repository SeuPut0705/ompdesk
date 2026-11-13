import { create } from "zustand";
import type { ChecksFrame } from "../../shared/checks-frame";

/**
 * Check control's frame, mirrored from main's relay (`src/shared/checks-frame.ts`). One per app, not per tab: the
 * sidebar block, the Checks page and every work board read the same frame. A pushed frame replaces the whole state;
 * a boot read only fills in when no frame landed first. `null` while main has none (no hub yet), and then nothing
 * of check control draws.
 */
export interface ChecksStore {
	frame: ChecksFrame | null;
	/** Counts the frames applied, so a slower boot read never overwrites a newer frame. */
	version: number;
	apply: (frame: ChecksFrame | null) => void;
	hydrateIfCurrent: (startedAt: number, frame: ChecksFrame | null) => boolean;
	reset: () => void;
}

export const useChecksStore = create<ChecksStore>()((set, get) => ({
	frame: null,
	version: 0,
	apply: frame => set({ frame, version: get().version + 1 }),
	hydrateIfCurrent: (startedAt, frame) => {
		if (get().version !== startedAt) return false;
		set({ frame, version: startedAt + 1 });
		return true;
	},
	reset: () => set({ frame: null, version: 0 }),
}));

/** Wire main's pushes and the boot read once (App mount). Returns the unsubscribe. */
export function subscribeChecks(): () => void {
	const unsubscribe = window.omp.events.onChecksFrame(frame => useChecksStore.getState().apply(frame));
	const startedAt = useChecksStore.getState().version;
	window.omp.checks
		.get()
		.then(frame => useChecksStore.getState().hydrateIfCurrent(startedAt, frame ?? null))
		// A host or page that cannot answer has no check control to show; a later push still fills it in.
		.catch(() => {});
	return unsubscribe;
}
