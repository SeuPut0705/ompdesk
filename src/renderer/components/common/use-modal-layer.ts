import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useBackLayer } from "../../hooks/use-back-layer";
import { isImeKeyEvent } from "../../lib/ime";
import { isTopmostDialog, registerDialogLayer } from "./dialog-layer";

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Each ancestor of an element, nearest first, with the index of the child on the way to it. */
type Place = Array<{ parent: Element; index: number }>;

function placeOf(element: Element): Place {
	const place: Place = [];
	for (let node = element; node.parentElement; node = node.parentElement) {
		place.push({
			parent: node.parentElement,
			index: Array.prototype.indexOf.call(node.parentElement.children, node),
		});
	}
	return place;
}

/**
 * Focus the control nearest to where a removed opener sat: in its nearest ancestor still on the page, the first
 * focusable from the opener's old position on (what took its place), else the last one before it. Without this the
 * focus of a dialog whose action removed its opener fell to the page, and the next Tab started over from the top.
 */
function focusNear(place: Place, panel: HTMLElement | null): void {
	for (const { parent, index } of place) {
		if (!parent.isConnected) continue;
		const children = Array.from(parent.children);
		for (const child of [...children.slice(index), ...children.slice(0, index).reverse()]) {
			const candidates = [child, ...child.querySelectorAll(FOCUSABLE)].filter(
				(element): element is HTMLElement =>
					element instanceof HTMLElement && element.matches(FOCUSABLE) && !panel?.contains(element),
			);
			const target = children.indexOf(child) < index ? candidates.at(-1) : candidates[0];
			if (target) {
				target.focus();
				return;
			}
		}
	}
}

/**
 * Modal-layer behavior shared by Modal (Dialog) and Sheet: while `open`, the
 * panel is the topmost dialog layer, focus moves into it and is trapped,
 * Escape closes it (only when topmost), and focus returns to the opener on
 * close. Focus, keyboard and layer scope live with `open`: the layer is
 * released the moment close begins, handing Escape to the dialog beneath
 * even while this one plays its exit animation. All of it is in place before
 * the dialog paints (a layout effect): set up after paint, an Escape pressed on
 * the frame a lazily loaded dialog first showed was lost.
 */
export function useModalLayer(open: boolean, panelRef: RefObject<HTMLElement | null>, onClose: () => void): void {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	// The system back gesture closes the topmost sheet or dialog (web shell only).
	useBackLayer(open, onClose);
	const restoreRef = useRef<HTMLElement | null>(null);
	/** Where the opener sat, for when the dialog's action removed it (a confirmed delete takes its row). */
	const restorePlace = useRef<Place>([]);
	/** The dialog closed while topmost: focus goes back to its opener once the commit is over. */
	const restorePending = useRef(false);

	useLayoutEffect(() => {
		if (!open) return;
		const unregisterLayer = registerDialogLayer(panelRef.current);
		restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		restorePlace.current = restoreRef.current ? placeOf(restoreRef.current) : [];
		const panel = panelRef.current;
		const active = document.activeElement;
		// Preserve a caller-autofocused control inside the new dialog, but never
		// leave focus on its trigger or on a dialog now covered by this one.
		if (!(active instanceof HTMLElement && panel?.contains(active))) {
			const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
			(first ?? panel)?.focus();
		}

		const onKeyDown = (event: KeyboardEvent) => {
			// A live IME composition owns Escape (candidate dismissal). Chromium can
			// retain the legacy 229 code after composition ends; an explicitly resolved
			// Escape with isComposing=false must still close the dialog.
			if (isImeKeyEvent(event)) return;
			// Include fullscreen/custom dialogs that do not use Modal in the layer
			// decision; a modal hidden beneath Settings must remain untouched.
			if (!isTopmostDialog(panel)) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				event.stopPropagation();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab" || !panel) return;
			const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
			if (items.length === 0) {
				event.preventDefault();
				panel.focus();
				return;
			}
			const firstEl = items[0];
			const lastEl = items[items.length - 1];
			if (event.shiftKey && document.activeElement === firstEl) {
				event.preventDefault();
				lastEl.focus();
			} else if (!event.shiftKey && document.activeElement === lastEl) {
				event.preventDefault();
				firstEl.focus();
			}
		};

		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			restorePending.current = isTopmostDialog(panel);
			unregisterLayer();
		};
	}, [open, panelRef]);

	// Focus returns to the opener in a passive cleanup: a layout cleanup runs inside React's commit, and React then
	// puts focus back on whatever held it before the commit (the closing dialog's button). A dialog that took focus
	// meanwhile (opened in the same commit) keeps it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `open` going false is what runs this cleanup.
	useEffect(
		() => () => {
			if (!restorePending.current) return;
			restorePending.current = false;
			const active = document.activeElement;
			const panel = panelRef.current;
			if (active instanceof HTMLElement && active !== document.body && !panel?.contains(active)) return;
			const opener = restoreRef.current;
			if (opener?.isConnected) opener.focus();
			else focusNear(restorePlace.current, panel);
		},
		[open, panelRef],
	);
}
