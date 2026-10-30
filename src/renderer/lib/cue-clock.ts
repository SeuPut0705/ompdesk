/**
 * The working cues loop for as long as work runs (a title's light and the composer's sweep, `common/LiveShimmer.tsx`;
 * the sidebar's arcs, `common/WorkingArc.tsx`; the work card's sweep and rings, the board's pulse, spinners). A running
 * compositor animation has the compositor, Viz and the GPU draw a frame at every vsync, up to 120 a second on a
 * ProMotion display, whether or not its value changed (a `steps()` easing measured no saving): with five sessions
 * working that is about a third of a GPU core (e2e/load-performance.e2e.ts, 30 Oct 2026: GPU 34 % with every loop
 * running, 4 % with none).
 *
 * While the window is on screen but not focused (the person works in another app, often the very tools the agents
 * run), every looping animation is held (playback rate 0, so its play state stays `running`) and one clock moves them
 * all together every `CUE_STEP_MS` to where they would be: they keep moving (the owner reads a still cue as stalled)
 * at ten frames a second, all on the same frame. Focus gives them back their own pace on the same phase. A hidden window
 * draws nothing anyway, so the clock stops there (the cues also rest, `data-paused`).
 */

/** How often the shared clock moves the held loops while the window is unfocused: ten frames a second. */
export const CUE_STEP_MS = 100;

/**
 * Follow the window's focus for every looping animation of `view`'s document: held and moved by one clock while
 * visible and unfocused, their own pace otherwise. A loop that starts meanwhile (a session starts working) joins at
 * its `animationstart`. Returns the uninstall, which gives every held loop its pace back.
 */
export function installCueClock(view: Window = window): () => void {
	const doc = view.document;
	if (typeof doc.getAnimations !== "function") return () => undefined;
	/** Each held loop and its start time on the document clock: where it would be is `now - start`. */
	const held = new Map<Animation, number>();
	let timer: number | undefined;
	const release = () => {
		view.clearInterval(timer);
		timer = undefined;
		for (const [animation, start] of held) {
			if (animation.playState === "idle") continue;
			animation.playbackRate = 1;
			// Back on the phase it would have had all along (its own, or the cues' shared one).
			if (animation.playState === "running") animation.startTime = start;
		}
		held.clear();
	};
	const tick = () => {
		const now = Number(doc.timeline.currentTime ?? view.performance.now());
		for (const [animation, start] of held) {
			if (animation.playState === "idle") held.delete(animation);
			else if (animation.playState === "running") animation.currentTime = now - start;
		}
	};
	const holdNew = () => {
		for (const animation of doc.getAnimations()) {
			if (
				held.has(animation) ||
				animation.playState !== "running" ||
				animation.startTime === null ||
				animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY
			)
				continue;
			held.set(animation, Number(animation.startTime));
			animation.playbackRate = 0;
		}
		tick();
	};
	let queued = false;
	const sync = () => {
		queued = false;
		// hasFocus() also holds while focus sits in a child frame (a preview), where window blur fires.
		const away = doc.visibilityState === "visible" && !doc.hasFocus();
		if (!away) {
			release();
			return;
		}
		holdNew();
		timer ??= view.setInterval(tick, CUE_STEP_MS);
	};
	const later = () => {
		if (queued) return;
		queued = true;
		view.setTimeout(sync, 0);
	};
	const onStart = () => {
		if (timer !== undefined) later();
	};
	view.addEventListener("focus", later);
	view.addEventListener("blur", later);
	doc.addEventListener("visibilitychange", later);
	doc.addEventListener("animationstart", onStart, true);
	later();
	return () => {
		view.removeEventListener("focus", later);
		view.removeEventListener("blur", later);
		doc.removeEventListener("visibilitychange", later);
		doc.removeEventListener("animationstart", onStart, true);
		release();
	};
}
