import { useEffect, useState } from "react";

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
