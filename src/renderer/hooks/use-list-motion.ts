import { type RefObject, useLayoutEffect, useRef } from "react";
import { motionAllowed, motionPlay } from "../lib/motion";

/**
 * A list whose rows glide to their new places when rows are added, removed or reordered (FLIP, `lib/motion-play.ts`
 * `playListMotion`): each row carries `data-flip-key`; `selector` finds them under the list. With `enter`, a row that
 * was not there before rises in.
 *
 * Positions are read only when the keyed rows change. Between such commits they are read again on the next frame,
 * after layout, so a row that only grew keeps an up-to-date start without a layout read in any commit. Until the
 * play-time code has loaded (right after the first screen) the list changes at once. `still` holds it still and reads
 * nothing (a list the person is filtering keystroke by keystroke: measuring 500 rows a keystroke cost ~5 % of a core).
 */
export function useListMotion(
	listRef: RefObject<HTMLElement | null>,
	options: { selector?: string; enter?: boolean; still?: boolean } = {},
): void {
	const { selector = "[data-flip-key]", enter = false, still = false } = options;
	const last = useRef<{ keys: string; tops: Map<string, number> } | null>(null);
	const pending = useRef(false);

	useLayoutEffect(() => {
		const list = listRef.current;
		const play = motionPlay();
		if (!list || !play || still || !motionAllowed()) {
			last.current = null;
			return;
		}
		let keys = "";
		for (const row of list.querySelectorAll<HTMLElement>(selector)) keys += `${row.dataset.flipKey}\n`;
		const previous = last.current;
		if (previous && previous.keys === keys) {
			// A page without frames (a test's DOM) reads at once.
			if (typeof requestAnimationFrame !== "function") {
				previous.tops = play.measureList(list, selector);
				return;
			}
			if (pending.current) return;
			pending.current = true;
			requestAnimationFrame(() => {
				pending.current = false;
				if (last.current?.keys === keys && listRef.current)
					last.current.tops = play.measureList(listRef.current, selector);
			});
			return;
		}
		const tops = previous
			? play.playListMotion(list, selector, previous.tops, { enter })
			: play.measureList(list, selector);
		last.current = { keys, tops };
	});
}
