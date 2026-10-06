import { type RefObject, useEffect, useRef } from "react";
import { isImeKeyEvent } from "../../lib/ime";
import { isTopmostDialog, registerDialogLayer } from "./dialog-layer";

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal-layer behavior shared by Modal (Dialog) and Sheet: while `open`, the
 * panel is the topmost dialog layer, focus moves into it and is trapped,
 * Escape closes it (only when topmost), and focus returns to the opener on
 * close. Focus, keyboard and layer scope live with `open`: the layer is
 * released the moment close begins, handing Escape to the dialog beneath
 * even while this one plays its exit animation.
 */
export function useModalLayer(open: boolean, panelRef: RefObject<HTMLElement | null>, onClose: () => void): void {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const restoreRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const unregisterLayer = registerDialogLayer(panelRef.current);
		restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
			const wasTopmost = isTopmostDialog(panel);
			unregisterLayer();
			if (wasTopmost) restoreRef.current?.focus();
		};
	}, [open, panelRef]);
}
