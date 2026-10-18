import { useCallback, useRef } from "react";

/**
 * A callback whose identity never changes and that always runs the latest render's `fn`: a memoised child
 * (the composer toolbar) keeps its props while the draft changes on every keystroke. Only for event handlers;
 * never call it during render.
 */
export function useStableCallback<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
	const latest = useRef(fn);
	latest.current = fn;
	return useCallback((...args: Args) => latest.current(...args), []);
}
