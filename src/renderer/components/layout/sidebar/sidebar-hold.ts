import {
	createContext,
	type RefObject,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { holdPlaces } from "../../../../shared/sidebar-rows";

/**
 * Whether the person points at the sidebar's list. While they do, every list in it (this computer's projects and rows,
 * a paired computer's section, a family's children, the phone's drawer) keeps its rows where they were drawn
 * (`useHeld`): the row a person sees under the pointer is the one a click selects. What other sessions changed
 * meanwhile arrives when the pointer leaves.
 */
export const SidebarHoldContext = createContext(false);

/** A touch has no hover: its list holds from the touch until its tap's click has run. */
const TOUCH_RELEASE_MS = 400;

/**
 * True while the pointer is over `ref`'s element: its last position lies in the element's box, the window kept its
 * focus and no key went to anything outside the list since (typing in the composer with the mouse resting over the
 * sidebar is not pointing at it). Read from where the pointer is, not from the list's boundary events: a tab switch's
 * view transition covers the page for a moment, and the list heard `pointerleave` under a pointer that never moved.
 */
export function usePointingAt(ref: RefObject<HTMLElement | null>): boolean {
	const [pointing, setPointing] = useState(false);
	useEffect(() => {
		let touchRelease: number | undefined;
		const over = (event: PointerEvent) => {
			const box = ref.current?.getBoundingClientRect();
			return (
				box !== undefined &&
				event.clientX >= box.left &&
				event.clientX < box.right &&
				event.clientY >= box.top &&
				event.clientY < box.bottom
			);
		};
		const leave = () => {
			clearTimeout(touchRelease);
			setPointing(false);
		};
		const moved = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			clearTimeout(touchRelease);
			setPointing(over(event));
		};
		const pressed = (event: PointerEvent) => {
			clearTimeout(touchRelease);
			setPointing(over(event));
		};
		// A tap's pointer is gone before its click is dispatched: release once that click has run.
		const lifted = (event: PointerEvent) => {
			if (event.pointerType !== "touch") return;
			clearTimeout(touchRelease);
			touchRelease = window.setTimeout(() => setPointing(false), TOUCH_RELEASE_MS);
		};
		const outOfWindow = (event: PointerEvent) => {
			if (event.relatedTarget === null && event.pointerType !== "touch") leave();
		};
		const keyDown = (event: KeyboardEvent) => {
			if (!(event.target instanceof Node && ref.current?.contains(event.target))) leave();
		};
		document.addEventListener("pointermove", moved, true);
		document.addEventListener("pointerover", moved, true);
		document.addEventListener("pointerdown", pressed, true);
		document.addEventListener("pointerup", lifted, true);
		document.addEventListener("pointercancel", lifted, true);
		document.addEventListener("pointerout", outOfWindow, true);
		document.addEventListener("keydown", keyDown, true);
		window.addEventListener("blur", leave);
		return () => {
			clearTimeout(touchRelease);
			document.removeEventListener("pointermove", moved, true);
			document.removeEventListener("pointerover", moved, true);
			document.removeEventListener("pointerdown", pressed, true);
			document.removeEventListener("pointerup", lifted, true);
			document.removeEventListener("pointercancel", lifted, true);
			document.removeEventListener("pointerout", outOfWindow, true);
			document.removeEventListener("keydown", keyDown, true);
			window.removeEventListener("blur", leave);
		};
	}, [ref]);
	return pointing;
}

/**
 * `now` as drawn while the person points at the list (`SidebarHoldContext`, or `holding` where the caller is the list
 * that provides it): `hold(shown, now)` places it where the last drawn value had its rows. A change the person makes
 * (`rebase`, by content: their order, pins, archive, filter, a fold they open) is drawn at once, as is everything when
 * the pointer leaves.
 */
export function useHeld<T>(now: T, hold: (shown: T, now: T) => T, rebase: string, holding?: boolean): T {
	const pointed = useContext(SidebarHoldContext);
	const held = holding ?? pointed;
	const shown = useRef(now);
	const base = useRef(rebase);
	const same = base.current === rebase;
	const drawn = useMemo(() => (held && same ? hold(shown.current, now) : now), [held, same, now, hold]);
	useLayoutEffect(() => {
		shown.current = drawn;
		base.current = rebase;
	});
	return drawn;
}

/** `useHeld` for a flat list keyed by `keyOf` (a family's children, a project's loose children). */
export function useHeldList<T>(now: readonly T[], keyOf: (item: T) => string, rebase: string): readonly T[] {
	const hold = useMemo(() => (shown: readonly T[], fresh: readonly T[]) => holdPlaces(shown, fresh, keyOf), [keyOf]);
	return useHeld(now, hold, rebase);
}
