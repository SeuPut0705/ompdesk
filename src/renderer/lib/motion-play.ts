/**
 * The motion system's play-time code (docs/motion-design.md): what moves a list, a height or a leaving overlay once the
 * person acts. It is loaded right after the first screen (`loadMotionPlay` in lib/motion.ts, started by main.tsx), so
 * the paired phone's first screen does not carry it; nothing on that screen moves before it is there.
 */
import { motionAllowed, motionEase, motionMs, motionTravel } from "./motion";

/**
 * Where each keyed (`data-flip-key`) element of a list sits, relative to the list's own box, so a scroll of the list
 * or the page moves nothing. Read after a commit, compared after the next one.
 */
export function measureList(list: HTMLElement, selector: string): Map<string, number> {
	const origin = list.getBoundingClientRect().top;
	const tops = new Map<string, number>();
	for (const element of list.querySelectorAll<HTMLElement>(selector)) {
		const key = element.dataset.flipKey;
		if (key !== undefined) tops.set(key, element.getBoundingClientRect().top - origin);
	}
	return tops;
}

/**
 * FLIP: every keyed element that moved since `before` starts where it was and glides to where it is (transform only,
 * the spring curve, `med`); with `enter`, an element that was not there rises in (`fast`, `--sc-motion-stagger` apart,
 * at most 8). A move longer than the list's visible height is not animated: it reads as a jump either way. Returns
 * the list's measure now, to compare against next time.
 */
export function playListMotion(
	list: HTMLElement,
	selector: string,
	before: Map<string, number>,
	options: { enter?: boolean } = {},
): Map<string, number> {
	const after = measureList(list, selector);
	const move = motionMs("med");
	if (move === 0 || before.size === 0 || typeof list.animate !== "function") return after;
	const reach = list.clientHeight || Number.POSITIVE_INFINITY;
	const { stagger, rise } = motionTravel();
	let entering = 0;
	for (const element of list.querySelectorAll<HTMLElement>(selector)) {
		const key = element.dataset.flipKey;
		const now = key === undefined ? undefined : after.get(key);
		if (key === undefined || now === undefined) continue;
		const was = before.get(key);
		if (was === undefined) {
			if (!options.enter || entering >= 8) continue;
			element.animate(
				[
					{ opacity: 0, transform: `translateY(${-rise}px)` },
					{ opacity: 1, transform: "none" },
				],
				{ duration: motionMs("fast"), delay: entering * stagger, easing: motionEase("enter"), fill: "backwards" },
			);
			entering += 1;
			continue;
		}
		const delta = was - now;
		if (Math.abs(delta) < 1 || Math.abs(delta) > reach) continue;
		element.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
			duration: move,
			easing: motionEase("spring"),
			composite: "add",
		});
	}
	return after;
}

/**
 * Open or close an element's height between `from` and `to` pixels (`med` decelerating open, `fast` accelerating
 * closed), clipping what overflows meanwhile. A height taller than the window is not animated: the move would run off
 * screen, and laying out that much every frame drops frames. Returns the running animation, or null when nothing
 * moves.
 */
export function animateHeight(element: HTMLElement, from: number, to: number): Animation | null {
	const opening = to > from;
	const duration = motionMs(opening ? "med" : "fast");
	if (duration === 0 || Math.abs(to - from) < 1 || typeof element.animate !== "function") return null;
	if (typeof window !== "undefined" && Math.max(from, to) > window.innerHeight) return null;
	return element.animate(
		[
			{ height: `${from}px`, overflow: "clip" },
			{ height: `${to}px`, overflow: "clip" },
		],
		{ duration, easing: motionEase(opening ? "enter" : "exit") },
	);
}

/** Each enter class and the exit class it leaves with (global.css). */
const EXIT_OF: Record<string, string> = {
	"omp-fade-in": "omp-fade-out",
	"omp-pop-in": "omp-pop-out",
	"omp-scale-in": "omp-scale-out",
	"omp-sheet-in-bottom": "omp-sheet-out",
};

/**
 * Leave a copy of `element` behind that plays its exit where it stood, for a surface whose owner unmounts it the
 * moment its request is answered and keeps no state to hold it with (the agent's prompt card). Call it from the
 * surface's layout-effect cleanup, while the element is still in the page. The copy is fixed over the old box, inert,
 * hidden from assistive tech, stripped of ids and `data-*` hooks, and removes itself when its animations end (none
 * when motion is off: nothing is left).
 */
export function leaveGhost(element: HTMLElement | null): void {
	if (!element?.isConnected || !motionAllowed() || typeof element.getAnimations !== "function") return;
	const box = element.getBoundingClientRect();
	if (box.width === 0 || box.height === 0) return;
	const ghost = element.cloneNode(true) as HTMLElement;
	for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")]) {
		node.removeAttribute("id");
		node.removeAttribute("tabindex");
		node.removeAttribute("role");
		for (const name of node.getAttributeNames()) if (name.startsWith("data-")) node.removeAttribute(name);
		for (const enter of Array.from(node.classList)) {
			const exit = EXIT_OF[enter];
			if (exit) node.classList.replace(enter, exit);
		}
	}
	ghost.inert = true;
	ghost.setAttribute("aria-hidden", "true");
	Object.assign(ghost.style, {
		position: "fixed",
		left: `${box.left}px`,
		top: `${box.top}px`,
		width: `${box.width}px`,
		height: `${box.height}px`,
		margin: "0",
		pointerEvents: "none",
		zIndex: "var(--sc-z-popover)",
	});
	document.body.append(ghost);
	const running = ghost.getAnimations({ subtree: true });
	if (running.length === 0) ghost.remove();
	else void Promise.allSettled(running.map(animation => animation.finished)).then(() => ghost.remove());
}
