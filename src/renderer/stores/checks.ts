import { create } from "zustand";
import type { ChecksFrame } from "../../shared/checks-frame";
import { snapshots } from "../lib/snapshot-cache";

/**
 * Check control's frame, mirrored from main's relay (`src/shared/checks-frame.ts`). One per app, not per tab: the
 * sidebar block, the Checks page and every work board read the same frame. A pushed frame replaces the whole state;
 * a boot read only fills in when no frame landed first. `null` while main has none (no hub yet), and then nothing
 * of check control draws.
 *
 * The last frame is kept in the snapshot cache (`panel` kind, this page's own host: the frame is always this
 * computer's hub, a phone's page its host's), so a reload paints it on the first frame instead of the sidebar block
 * popping in when main answers (no-loading-screens). It is `remembered` until the first frame of this run replaces
 * it; a boot read that answers no frame (no hub) clears it.
 */
export interface ChecksStore {
	frame: ChecksFrame | null;
	/** The frame shown is the last run's, painted before main answered. */
	remembered: boolean;
	/** Counts the frames applied, so a slower boot read never overwrites a newer frame. */
	version: number;
	apply: (frame: ChecksFrame | null) => void;
	hydrateIfCurrent: (startedAt: number, frame: ChecksFrame | null) => boolean;
	reset: () => void;
}

const SNAPSHOT_NS = "local";
const SNAPSHOT_KEY = "checks.frame";
/** At most one write per this long, however often the hub changes (a write is the whole frame). */
const WRITE_EVERY_MS = 2000;

function rememberedFrame(): ChecksFrame | null {
	const hit = snapshots().read<ChecksFrame>("panel", SNAPSHOT_NS, SNAPSHOT_KEY);
	return hit?.value?.snapshot ? hit.value : null;
}

let latest: ChecksFrame | null = null;
let writing: ReturnType<typeof setTimeout> | null = null;

function remember(frame: ChecksFrame | null): void {
	latest = frame;
	writing ??= setTimeout(() => {
		writing = null;
		if (latest) snapshots().write("panel", SNAPSHOT_NS, SNAPSHOT_KEY, latest);
		else snapshots().remove("panel", SNAPSHOT_NS, SNAPSHOT_KEY);
	}, WRITE_EVERY_MS);
}

const initial = rememberedFrame();

export const useChecksStore = create<ChecksStore>()((set, get) => ({
	frame: initial,
	remembered: initial !== null,
	version: 0,
	apply: frame => {
		set({ frame, remembered: false, version: get().version + 1 });
		remember(frame);
	},
	hydrateIfCurrent: (startedAt, frame) => {
		if (get().version !== startedAt) return false;
		set({ frame, remembered: false, version: startedAt + 1 });
		remember(frame);
		return true;
	},
	reset: () => {
		clearTimeout(writing ?? undefined);
		writing = null;
		latest = null;
		set({ frame: null, remembered: false, version: 0 });
	},
}));

/** Tests: the state a fresh page starts in, from what the snapshot cache holds now. */
export function restartChecksForTest(): void {
	const frame = rememberedFrame();
	useChecksStore.setState({ frame, remembered: frame !== null, version: 0 });
}

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
