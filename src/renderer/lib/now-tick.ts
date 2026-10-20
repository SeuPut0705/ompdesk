import { useEffect, useState } from "react";
import { formatTimeAgo } from "./format";

type ClockListener = (now: number) => void;

const listeners = new Set<ClockListener>();
let interval: number | null = null;

function tick(): void {
	const now = Date.now();
	for (const fn of listeners) fn(now);
}

function stop(): void {
	if (interval === null) return;
	window.clearInterval(interval);
	interval = null;
}

/** Hidden: nobody sees the clocks, so they stand still; back in view they catch up at once. */
function onVisibility(): void {
	if (document.visibilityState === "hidden") return stop();
	if (interval !== null) return;
	tick();
	interval = window.setInterval(tick, 1000);
}

function subscribe(listener: ClockListener): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		document.addEventListener("visibilitychange", onVisibility);
		if (document.visibilityState !== "hidden") interval = window.setInterval(tick, 1000);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		document.removeEventListener("visibilitychange", onVisibility);
		stop();
	};
}

/**
 * Wall clock that advances once a second while `active` and the window is in view, then freezes.
 *
 * Every live elapsed-time row shares one interval: a turn with a dozen running
 * cards used to register a dozen timers, each forcing its own re-render, and
 * each had to be stopped by its row reaching a terminal status.
 */
export function useNowTick(active: boolean | undefined): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		return subscribe(setNow);
	}, [active]);
	return now;
}

/**
 * {@link formatTimeAgo} of `iso`, kept current on the same shared clock: the caller re-renders only when the text
 * changes ("3m" → "4m"), so a list's ages move without a render a second per row.
 */
export function useTimeAgo(iso: string | undefined | null): string {
	const [label, setLabel] = useState(() => formatTimeAgo(iso));
	useEffect(() => {
		setLabel(formatTimeAgo(iso));
		if (!iso) return;
		return subscribe(() => setLabel(formatTimeAgo(iso)));
	}, [iso]);
	return label;
}
