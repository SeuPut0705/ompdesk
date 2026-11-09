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
import { departedRow, holdPlaces } from "../../../../shared/sidebar-rows";

/**
 * Whether the person aims at the sidebar's list. While they do, every list in it (this computer's projects and rows,
 * a paired computer's section, a family's children, the phone's drawer) keeps its rows where they were drawn
 * (`useHeld`): the row a person sees under the pointer is the one a click selects. What other sessions changed
 * meanwhile arrives when they stop.
 */
export const SidebarHoldContext = createContext(false);

/**
 * How long a pointer resting on the list still aims: a person moves to a row and clicks within it. A pointer left
 * there for longer is not aiming, and the rows a person watches with the mouse resting on the sidebar stay live.
 */
const AIM_MS = 2000;
/** A touch has no hover: its list holds from the touch until its tap's click has run. */
const TOUCH_RELEASE_MS = 400;

/**
 * True while the person aims at `ref`'s element: the pointer moved over the element's box within `AIM_MS`, or is
 * pressed there, and no key went to anything outside the list since (typing in the composer is not aiming), the window
 * kept its focus and the pointer stayed in it. Read from where the pointer is, not from the list's boundary events: a
 * tab switch's view transition covers the page for a moment, and the list heard `pointerleave` under a pointer that
 * never moved.
 */
export function usePointingAt(ref: RefObject<HTMLElement | null>): boolean {
	const [pointing, setPointing] = useState(false);
	useEffect(() => {
		let release: number | undefined;
		let pressed = false;
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
		const releaseAfter = (ms: number) => {
			clearTimeout(release);
			release = window.setTimeout(() => setPointing(false), ms);
		};
		const leave = () => {
			clearTimeout(release);
			pressed = false;
			setPointing(false);
		};
		const moved = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			if (!over(event)) return leave();
			setPointing(true);
			if (!pressed) releaseAfter(AIM_MS);
		};
		const down = (event: PointerEvent) => {
			if (!over(event)) return;
			pressed = true;
			clearTimeout(release);
			setPointing(true);
		};
		// A tap's pointer is gone before its click is dispatched: release once that click has run.
		const up = (event: PointerEvent) => {
			if (!pressed) return;
			pressed = false;
			releaseAfter(event.pointerType === "touch" ? TOUCH_RELEASE_MS : AIM_MS);
		};
		const outOfWindow = (event: PointerEvent) => {
			if (event.relatedTarget === null && event.pointerType !== "touch") leave();
		};
		const keyDown = (event: KeyboardEvent) => {
			if (!(event.target instanceof Node && ref.current?.contains(event.target))) leave();
		};
		document.addEventListener("pointermove", moved, true);
		document.addEventListener("pointerover", moved, true);
		document.addEventListener("pointerdown", down, true);
		document.addEventListener("pointerup", up, true);
		document.addEventListener("pointercancel", up, true);
		document.addEventListener("pointerout", outOfWindow, true);
		document.addEventListener("keydown", keyDown, true);
		window.addEventListener("blur", leave);
		return () => {
			clearTimeout(release);
			document.removeEventListener("pointermove", moved, true);
			document.removeEventListener("pointerover", moved, true);
			document.removeEventListener("pointerdown", down, true);
			document.removeEventListener("pointerup", up, true);
			document.removeEventListener("pointercancel", up, true);
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

/**
 * `useHeld` for a flat list keyed by `keyOf` (a family's children, a project's loose children): one that left is drawn
 * as an empty place (`departed`) until the pointer leaves.
 */
export function useHeldList<T extends { departed?: true }>(
	now: readonly T[],
	keyOf: (item: T) => string,
	rebase: string,
): readonly T[] {
	const hold = useMemo(
		() => (shown: readonly T[], fresh: readonly T[]) => holdPlaces(shown, fresh, keyOf, departedRow),
		[keyOf],
	);
	return useHeld(now, hold, rebase);
}
