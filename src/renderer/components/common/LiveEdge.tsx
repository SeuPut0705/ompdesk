/**
 * The "work is going on" light: one soft accent comet travelling the rounded border of the card it sits in,
 * clockwise, at an even pace along the edge. The composer box wears it while its turn runs, and so does every card
 * that shows a working session (a sidebar row, a split pane's header; `layout/SessionLiveEdge`). One look, one
 * implementation: the card only needs to be `position: relative`, rounded by its own `border-radius`; the light is
 * drawn on its border and takes no pointer events.
 *
 * States, all one light (`live-light.ts` has the geometry and the clock):
 * - `turn`: the work in front runs. The full comet.
 * - `background`: the turn is idle and work it started still runs. The same comet at the same pace, dimmer and
 *   shorter (its faint tail drops), so a switch either way only crossfades: nothing jumps.
 * - `waiting`: it waits on the person. No travelling light; the edge holds a calm, still warning tint.
 * - `null`: nothing works. A light that was on fades out (`LEAVE_MS`) before it goes; one that comes on fades in.
 *
 * Every light runs on the shared phase clock, so a light that mounts later (a new running row, a row that moved,
 * any remount) is where the others are, and a state change never restarts it.
 *
 * Cost rules: each pill is one compositor-only transform animation (no mask, no clip, no opacity group, no repaint per
 * frame); the lights rest while the window is hidden (`data-paused`) and go on from where they rested; reduced motion
 * and software compositing (`html[data-gpu="software"]`) draw a still edge and create no animation at all.
 */
import { type ReactElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export type LiveEdgeState = "turn" | "background" | "waiting";

/** How long a light takes to fade out once its work ended (components.css `.omp-live-edge` transitions). */
export const LIVE_EDGE_LEAVE_MS = 320;

function subscribeVisibility(listener: () => void): () => void {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
}
const documentVisible = () => document.visibilityState !== "hidden";

/** Whether the window is on screen; a hidden one has nothing to animate for. */
export function useWindowVisible(): boolean {
	return useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeStill(listener: () => void): () => void {
	const query = window.matchMedia?.(REDUCED_MOTION);
	query?.addEventListener("change", listener);
	// Main marks software compositing once the GPU reports in, which can be after the first lights mounted.
	const marks = typeof MutationObserver === "function" ? new MutationObserver(listener) : null;
	marks?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-gpu"] });
	return () => {
		query?.removeEventListener("change", listener);
		marks?.disconnect();
	};
}

/** Reduced motion or software compositing: the light holds still (the CSS draws its still form). */
function stillLight(): boolean {
	return window.matchMedia?.(REDUCED_MOTION).matches === true || document.documentElement.dataset.gpu === "software";
}

export function LiveEdge({
	state,
	inside = false,
}: {
	/** What the work is doing; `null` when nothing works (a lit edge then fades out). */
	state: LiveEdgeState | null;
	/** Draw the 1 px ring inside the card's box instead of on its outer edge (cards that clip their overflow). */
	inside?: boolean;
}): ReactElement | null {
	const visible = useWindowVisible();
	const still = useSyncExternalStore(subscribeStill, stillLight, () => true);
	// The last state shown stays on screen while it fades out.
	const [shown, setShown] = useState(state);
	if (state !== null && state !== shown) setShown(state);
	useEffect(() => {
		if (state !== null) return;
		const timer = window.setTimeout(() => setShown(null), LIVE_EDGE_LEAVE_MS);
		return () => window.clearTimeout(timer);
	}, [state]);

	const edgeRef = useRef<HTMLSpanElement>(null);
	// The comet keeps running while it fades out into `waiting`, then stops (a long wait animates nothing).
	const moving = shown === "turn" || shown === "background";
	const [lingering, setLingering] = useState(moving);
	if (moving && !lingering) setLingering(true);
	useEffect(() => {
		if (moving) return;
		const timer = window.setTimeout(() => setLingering(false), LIVE_EDGE_LEAVE_MS);
		return () => window.clearTimeout(timer);
	}, [moving]);
	const travelling = !still && shown !== null && (moving || lingering);

	// Lay the comet's pills on the edge and run each on the shared clock. The runner is its own chunk (the phone's
	// first screen holds no geometry it may never draw); the light's first frames are its fade-in anyway.
	useLayoutEffect(() => {
		const edge = edgeRef.current;
		if (!travelling || !edge || typeof edge.animate !== "function") return;
		let stop: (() => void) | undefined;
		let gone = false;
		void import("./live-comet").then(({ startComet }) => {
			if (!gone) stop = startComet(edge, visible);
		});
		return () => {
			gone = true;
			stop?.();
		};
	}, [travelling, visible]);

	if (shown === null) return null;
	return (
		<span
			aria-hidden
			ref={edgeRef}
			className="omp-live-edge"
			data-live-edge={shown}
			data-live-edge-inside={inside ? "" : undefined}
			data-leaving={state === null ? "" : undefined}
			data-paused={visible ? undefined : ""}
		/>
	);
}
