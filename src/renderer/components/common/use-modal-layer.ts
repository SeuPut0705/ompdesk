import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useBackLayer } from "../../hooks/use-back-layer";
import { isImeKeyEvent } from "../../lib/ime";
import { isTopmostDialog, registerDialogLayer } from "./dialog-layer";
import { focusNear, type Place, placeOf } from "./focus-place";

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where typing goes: a text field or a text area. Not a select (its arrow keys change the value), a checkbox, a radio,
 * a file or a range input.
 */
const FIELD =
	'textarea:not([disabled]), input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="submit"]):not([type="reset"]), [contenteditable="true"]';

/** A control that Enter, Space or an arrow key changes the value of: a dialog never opens on one. */
const STATEFUL =
	'select, input[type="checkbox"], input[type="radio"], input[type="range"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [aria-pressed]';

/** Never a first focus: the header's ✕, and whatever a dialog opts out (`data-dialog-nofocus` on it or around it). */
const NEVER_FIRST = "[data-dialog-close], [data-dialog-nofocus]";

/**
 * Where a dialog that focused nothing itself starts: the element it marks (`data-dialog-autofocus`), else its first
 * text field, else the first control of its body that changes nothing when pressed (a switch, a checkbox, a radio, a
 * toggle button such as a `Chip` toggle, or a select would flip or change its value at the first Enter, Space or
 * arrow), else the panel. Never the header's close
 * button: a ✕ opening wrapped in the focus ring is the loudest thing on screen, and typing would go nowhere. Escape
 * closes, and Tab still reaches every one of them.
 */
function firstFocus(panel: HTMLElement): HTMLElement {
	const marked = panel.querySelector<HTMLElement>("[data-dialog-autofocus]");
	if (marked) return marked;
	const field = [...panel.querySelectorAll<HTMLElement>(FIELD)].find(element => !element.closest(NEVER_FIRST));
	if (field) return field;
	const body = panel.querySelector<HTMLElement>("[data-dialog-body]") ?? panel;
	const control = [...body.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
		element => !element.closest(NEVER_FIRST) && !element.matches(STATEFUL),
	);
	return control ?? panel;
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
	const restorePlace = useRef<Place>(placeOf(null));
	/** The dialog closed while topmost: focus goes back to its opener once the commit is over. */
	const restorePending = useRef(false);

	useLayoutEffect(() => {
		if (!open) return;
		const unregisterLayer = registerDialogLayer(panelRef.current);
		restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		restorePlace.current = placeOf(restoreRef.current);
		const panel = panelRef.current;
		const active = document.activeElement;
		// Preserve a caller-autofocused control inside the new dialog, but never
		// leave focus on its trigger or on a dialog now covered by this one.
		if (!(active instanceof HTMLElement && panel?.contains(active))) {
			// A touch screen has no one at a keyboard: focus the panel itself, so the first control does not wear a
			// focus ring over a layer nobody tabbed into. Tab still enters at the first control.
			if (panel) (document.documentElement.dataset.input === "touch" ? panel : firstFocus(panel)).focus();
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
			if (event.shiftKey && (document.activeElement === firstEl || document.activeElement === panel)) {
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
