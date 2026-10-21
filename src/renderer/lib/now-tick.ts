import { useEffect, useRef, useState } from "react";
import { formatTimeAgo } from "./format";
import { useCurrentLang } from "./i18n";

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

type AgeValue = string | number | null | undefined;

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((label, i) => label === b[i]);
}

/**
 * `format` of each value ("3m", "5분 전"), kept current on the shared clock: the caller re-renders only when a label
 * changes, so a list of ages (a Settings device list, a scan history) moves without a render a second.
 * `format` should be stable (a module function): a new one restarts the subscription.
 */
export function useAgeLabels(values: readonly AgeValue[], format: (value: AgeValue) => string): readonly string[] {
	// The labels are words: a language switch reads them again at once, not at the clock's next tick.
	const lang = useCurrentLang();
	const key = `${lang}\n${values.map(value => value ?? "").join("\n")}`;
	const latest = useRef(values);
	latest.current = values;
	const [state, setState] = useState(() => ({ key, labels: values.map(format) }));
	useEffect(() => {
		const update = () =>
			setState(prev => {
				const labels = latest.current.map(format);
				return prev.key === key && sameLabels(prev.labels, labels) ? prev : { key, labels };
			});
		update();
		if (!latest.current.some(value => value != null && value !== "")) return;
		return subscribe(update);
	}, [key, format]);
	// A new value list reads at once; the effect then keeps it moving.
	return state.key === key ? state.labels : values.map(format);
}

/**
 * {@link formatTimeAgo} of `iso` (or epoch ms), kept current on the same shared clock: the caller re-renders only
 * when the text changes ("3m" → "4m"), so a row's age moves without a render a second.
 */
export function useTimeAgo(iso: string | number | undefined | null): string {
	return useAgeLabels([iso], formatTimeAgo)[0] ?? "";
}

/** {@link useAgeLabels} with {@link formatTimeAgo}, for a list's ages (strings or epoch ms). */
export function useTimeAgos(values: readonly AgeValue[]): readonly string[] {
	return useAgeLabels(values, formatTimeAgo);
}
