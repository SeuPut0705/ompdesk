import { useCallback, useRef, useSyncExternalStore } from "react";
import type { StoreApi } from "zustand/vanilla";

/** Ignore unrelated store events and coalesce streaming notifications into one browser frame. */
export function useFrameSelector<T, V>(
	store: Pick<StoreApi<T>, "getState" | "subscribe">,
	selector: (state: T) => V,
): V {
	const selectRef = useRef(selector);
	selectRef.current = selector;
	const subscribe = useCallback(
		(notify: () => void) => {
			let frame: number | null = null;
			let previous = selectRef.current(store.getState());
			const unsubscribe = store.subscribe(() => {
				const next = selectRef.current(store.getState());
				if (Object.is(previous, next)) return;
				previous = next;
				if (frame !== null) return;
				frame = window.requestAnimationFrame(() => {
					frame = null;
					notify();
				});
			});
			return () => {
				unsubscribe();
				if (frame !== null) window.cancelAnimationFrame(frame);
			};
		},
		[store],
	);
	return useSyncExternalStore(subscribe, () => selector(store.getState()));
}
