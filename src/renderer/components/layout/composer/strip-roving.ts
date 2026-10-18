/**
 * Keyboard route through an attachment strip (DI-9): one tab stop per strip, arrows (and Home/End) move between its
 * items, Delete/Backspace removes the focused item and Esc goes back to the field. A strip's items mark their main
 * control `data-strip-stop` and, inside the same `data-strip-item`, their remove control `data-strip-remove`.
 *
 * The tab stop is kept by the DOM, not by props: the items are memoised, and a roving index in state would
 * re-render all of them on every arrow press.
 */
import { type KeyboardEvent, type RefObject, useCallback, useLayoutEffect, useRef } from "react";

/** A strip's stops: items' main controls (a picture's zoom button is one without marking: it is shared UI). */
const STOP = "[data-strip-stop], [data-strip-item] > [data-zoomable-image]";

function stopsOf(strip: HTMLElement): HTMLElement[] {
	return Array.from(strip.querySelectorAll<HTMLElement>(STOP)).filter(stop => !stop.hasAttribute("disabled"));
}
/** Every stop but the active one leaves the tab order; the active one is the last focused, else the first. */
function syncTabStops(strip: HTMLElement, active: HTMLElement | null): void {
	const stops = stopsOf(strip);
	const current = active && stops.includes(active) ? active : stops[0];
	for (const stop of stops) stop.tabIndex = stop === current ? 0 : -1;
}

/** The last attachment of every strip inside a container, in document order ("Remove all" is no attachment). */
export function lastAttachmentStop(container: HTMLElement | null): HTMLElement | undefined {
	return container ? stopsOf(container).findLast(stop => stop.closest("[data-strip-item]") !== null) : undefined;
}

export interface RovingStrip<T extends HTMLElement> {
	ref: RefObject<T | null>;
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onFocus: (event: { target: EventTarget }) => void;
}

export function useRovingStrip<T extends HTMLElement>(focusField: () => void): RovingStrip<T> {
	const ref = useRef<T>(null);
	const active = useRef<HTMLElement | null>(null);
	// After every render of the strip: items that came or went change which one is the tab stop.
	useLayoutEffect(() => {
		if (ref.current) syncTabStops(ref.current, active.current);
	});
	const onFocus = useCallback((event: { target: EventTarget }) => {
		const strip = ref.current;
		const target = event.target as HTMLElement;
		if (!strip || typeof target.matches !== "function" || !target.matches(STOP)) return;
		active.current = target;
		syncTabStops(strip, target);
	}, []);
	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			const strip = ref.current;
			const target = event.target as HTMLElement;
			if (!strip || typeof target.matches !== "function" || !target.matches(STOP)) return;
			if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			const stops = stopsOf(strip);
			const index = stops.indexOf(target);
			const move = (to: number) => {
				event.preventDefault();
				stops[Math.max(0, Math.min(stops.length - 1, to))]?.focus();
			};
			switch (event.key) {
				case "ArrowRight":
				case "ArrowDown":
					return move(index + 1);
				case "ArrowLeft":
				case "ArrowUp":
					return move(index - 1);
				case "Home":
					return move(0);
				case "End":
					return move(stops.length - 1);
				case "Escape":
					event.preventDefault();
					event.stopPropagation();
					return focusField();
				case "Delete":
				case "Backspace": {
					const remove = target.closest("[data-strip-item]")?.querySelector<HTMLElement>("[data-strip-remove]");
					if (!remove) return;
					event.preventDefault();
					// The remove control puts focus back in the field once its item is gone.
					remove.click();
					return;
				}
			}
		},
		[focusField],
	);
	return { ref, onKeyDown, onFocus };
}
