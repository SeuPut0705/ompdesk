/**
 * The "work is going on" light: one slow accent light travelling the border of the card it sits in. The composer
 * box wears it while its turn runs, and so does every card that shows a running session (a sidebar row, a split
 * pane's header). One look, one implementation (components.css `.omp-live-edge`): the card only needs to be
 * `position: relative`, rounded by its own `border-radius`; the light is drawn on its border and takes no
 * pointer events. The composer's box (one per window) gets a conic light in a masked ring; a contained card
 * (`inside`; a dozen can be in view) gets the cheap form of the same light, two short bars running its top and
 * bottom edge in opposite directions over a still 1 px accent edge (the ring costs the GPU ~0.5 % a row).
 *
 * Cost rules: only a transform animates; it rests while the window is hidden (`data-paused`), and reduced motion
 * and software compositing (`html[data-gpu="software"]`) draw the still edge. Callers mount it only for a card
 * that is running, and never beside a waiting question (that card keeps its warning look).
 */
import { type ReactElement, useSyncExternalStore } from "react";

/** `turn`: the work in front runs. `background`: fainter and slower, for work that runs behind an idle turn. */
export type LiveEdgeState = "turn" | "background";

function subscribeVisibility(listener: () => void): () => void {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
}
const documentVisible = () => document.visibilityState !== "hidden";

/** Whether the window is on screen; a hidden one has nothing to animate for. */
export function useWindowVisible(): boolean {
	return useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
}

export function LiveEdge({
	state = "turn",
	inside = false,
}: {
	state?: LiveEdgeState;
	/** Draw the 1 px ring inside the card's box instead of on its outer edge (cards that clip their overflow). */
	inside?: boolean;
}): ReactElement {
	const visible = useWindowVisible();
	return (
		<span
			aria-hidden
			className="omp-live-edge"
			data-live-edge={state}
			data-live-edge-inside={inside ? "" : undefined}
			data-paused={visible ? undefined : ""}
		/>
	);
}
