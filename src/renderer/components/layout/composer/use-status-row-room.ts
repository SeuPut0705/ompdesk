/**
 * Whether the phone's status chip row has room: not while the soft keyboard is up (`html[data-kb="open"]`, set by
 * `lib/keyboard-inset.ts`) and not when the visible height is under 420 px (a landscape phone). While it is hidden the
 * `+` sheet carries Model / Mode / Tool approval / Delegation rows so nothing becomes unreachable.
 */
import { useSyncExternalStore } from "react";

/** Under this visible height (px) the row gives its 44 px back to the transcript. */
export const STATUS_ROW_MIN_VISIBLE_PX = 420;

/** Pure: the row shows with no keyboard and at least `STATUS_ROW_MIN_VISIBLE_PX` of visible height. */
export function statusRowFits(keyboardOpen: boolean, visibleHeight: number): boolean {
	return !keyboardOpen && visibleHeight >= STATUS_ROW_MIN_VISIBLE_PX;
}

function subscribe(onChange: () => void): () => void {
	window.addEventListener("resize", onChange);
	window.visualViewport?.addEventListener("resize", onChange);
	const observer = typeof MutationObserver === "function" ? new MutationObserver(onChange) : null;
	observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-kb"] });
	return () => {
		window.removeEventListener("resize", onChange);
		window.visualViewport?.removeEventListener("resize", onChange);
		observer?.disconnect();
	};
}

function snapshot(): boolean {
	const visible = window.visualViewport?.height || window.innerHeight || Number.POSITIVE_INFINITY;
	return statusRowFits(document.documentElement.dataset.kb === "open", visible);
}

export function useStatusRowRoom(): boolean {
	return useSyncExternalStore(subscribe, snapshot, () => true);
}
