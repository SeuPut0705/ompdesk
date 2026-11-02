import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { MOTION_SETTLED, motionAllowed, motionPlay } from "../lib/motion";

type ListMotionOptions = { selector?: string; enter?: boolean; still?: boolean };

/**
 * A list whose rows glide to their new places when rows are added, removed or reordered (FLIP, `lib/motion-play.ts`
 * `playListMotion`): each row carries `data-flip-key`; `selector` finds them under the list. With `enter`, a row that
 * was not there before rises in.
 *
 * The list's own DOM says when it changed (a MutationObserver), not the commits of the component holding the hook: a
 * row's own component (a family block that opens itself) changes the list in a commit the owner never sees, and the
 * owner's next commit (a focus on pointer down) then glided every row from where it had been before, under the
 * pointer. The observer runs after the commit's layout effects and before the frame is drawn. Positions are read when
 * the keyed rows change; after any other change they are read again on the next task, once per burst. Until the
 * play-time code has loaded (right after the first screen) the list changes at once. `still` holds it still and reads
 * nothing (a list the person is filtering keystroke by keystroke: measuring 500 rows a keystroke cost ~5 % of a core).
 * The options of the latest render apply, so one render can choose a selector for the change it commits.
 */
export function useListMotion(listRef: RefObject<HTMLElement | null>, options: ListMotionOptions = {}): void {
	const latest = useRef(options);
	const watched = useRef<{ list: HTMLElement; stop: () => void } | null>(null);

	useLayoutEffect(() => {
		latest.current = options;
		const list = listRef.current;
		if (watched.current?.list === list) return;
		watched.current?.stop();
		watched.current = list ? { list, stop: watchList(list, latest) } : null;
	});

	useEffect(
		() => () => {
			watched.current?.stop();
			watched.current = null;
		},
		[],
	);
}

function watchList(list: HTMLElement, latest: { readonly current: ListMotionOptions }): () => void {
	// A test's DOM without one: its lists change at once.
	if (typeof MutationObserver !== "function") return () => {};
	let last: { keys: string; tops: Map<string, number> } | null = null;
	let pending = false;
	let stopped = false;
	const selectorNow = () => latest.current.selector ?? "[data-flip-key]";
	const keysNow = (selector: string) => {
		let keys = "";
		for (const row of list.querySelectorAll<HTMLElement>(selector)) keys += `${row.dataset.flipKey}\n`;
		return keys;
	};
	const measure = () => {
		const play = motionPlay();
		const selector = selectorNow();
		last =
			play && !latest.current.still && motionAllowed()
				? { keys: keysNow(selector), tops: play.measureList(list, selector) }
				: null;
	};
	const changed = () => {
		const play = motionPlay();
		const selector = selectorNow();
		if (!play || latest.current.still || !motionAllowed()) {
			last = null;
			return;
		}
		const keys = keysNow(selector);
		if (last && last.keys === keys) {
			// Where the rows rest once this change is laid out, read once per burst of changes.
			if (pending) return;
			pending = true;
			setTimeout(() => {
				pending = false;
				if (!stopped) measure();
			}, 0);
			return;
		}
		const tops = last
			? play.playListMotion(list, selector, last.tops, { enter: latest.current.enter })
			: play.measureList(list, selector);
		last = { keys, tops };
	};
	const observer = new MutationObserver(changed);
	observer.observe(list, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["class", "hidden", "data-flip-key"],
	});
	// A fold inside the list (Collapse) moved the rows below it without a change to the list's DOM.
	list.addEventListener(MOTION_SETTLED, measure);
	measure();
	return () => {
		observer.disconnect();
		list.removeEventListener(MOTION_SETTLED, measure);
		stopped = true;
	};
}
