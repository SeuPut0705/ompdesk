import { useEffect, useRef, useState } from "react";

export interface Presence<T> {
	item: T;
	/** True while a removed item is still on screen for its exit animation. */
	exiting: boolean;
}

/**
 * Keeps an item that left `items` in the list, flagged `exiting`, for `ms` so CSS can animate it out;
 * nothing is kept under `prefers-reduced-motion`. A removed item returns to its old position (clamped),
 * and one that comes back before the time is up is live again.
 */
export function usePresence<T>(items: readonly T[], keyOf: (item: T) => string, ms = 180): Presence<T>[] {
	const previous = useRef<readonly T[]>(items);
	const [ghosts, setGhosts] = useState<{ item: T; key: string; index: number }[]>([]);
	const timers = useRef<number[]>([]);
	const keyRef = useRef(keyOf);
	keyRef.current = keyOf;

	useEffect(() => {
		const keys = new Set(items.map(keyRef.current));
		const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
		const gone = reduced
			? []
			: previous.current
					.map((item, index) => ({ item, index, key: keyRef.current(item) }))
					.filter(entry => !keys.has(entry.key));
		previous.current = items;
		setGhosts(current => {
			const kept = current.filter(ghost => !keys.has(ghost.key));
			const added = gone.filter(entry => !kept.some(ghost => ghost.key === entry.key));
			return kept.length === current.length && added.length === 0 ? current : [...kept, ...added];
		});
		for (const entry of gone) {
			timers.current.push(
				window.setTimeout(() => setGhosts(current => current.filter(ghost => ghost.key !== entry.key)), ms),
			);
		}
	}, [items, ms]);

	useEffect(
		() => () => {
			for (const timer of timers.current) window.clearTimeout(timer);
		},
		[],
	);

	const rows: Presence<T>[] = items.map(item => ({ item, exiting: false }));
	for (const ghost of [...ghosts].sort((a, b) => a.index - b.index)) {
		rows.splice(Math.min(ghost.index, rows.length), 0, { item: ghost.item, exiting: true });
	}
	return rows;
}
