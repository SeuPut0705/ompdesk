/**
 * Popover — a small, non-modal panel anchored to the control that opened it.
 *
 * Container policy (design-spec.md): use a Popover for quick, contextual
 * controls that keep the page visible — run settings next to the composer,
 * session status from the title bar, a filter, a colour or emoji choice.
 * Content must fit without scrolling a long way; anything bigger is a Sheet
 * or a page. Focus moves into the popover on open; Escape, an outside press
 * or `onClose` dismisses it and focus returns to the anchor. For a plain
 * list of actions use MenuButton instead.
 */

import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { isImeKeyEvent } from "../../lib/ime";
import { isTopmostDialog, registerDialogLayer } from "./dialog-layer";

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

const GAP = 6;
const MARGIN = 8;
const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Popover panel visuals. */
export function PopoverSurface({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<div
			className={cx(
				"max-w-[min(360px,calc(100vw-16px))] rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-3 text-(--sc-text) shadow-(--sc-shadow-md)",
				className,
			)}
		>
			{children}
		</div>
	);
}

export interface PopoverProps {
	open: boolean;
	onClose: () => void;
	/** The trigger; the popover lines up with its edge and returns focus to it. */
	anchorRef: RefObject<HTMLElement | null>;
	placement?: PopoverPlacement;
	/** Accessible name of the panel. */
	ariaLabel: string;
	className?: string;
	children: ReactNode;
}

export function Popover({
	open,
	onClose,
	anchorRef,
	placement = "bottom-start",
	ariaLabel,
	className,
	children,
}: PopoverProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

	useLayoutEffect(() => {
		if (!open) {
			setPosition(null);
			return;
		}
		const place = () => {
			const anchor = anchorRef.current?.getBoundingClientRect();
			const panel = panelRef.current?.getBoundingClientRect();
			if (!anchor || !panel) return;
			let left = placement.endsWith("end") ? anchor.right - panel.width : anchor.left;
			let top = placement.startsWith("top") ? anchor.top - panel.height - GAP : anchor.bottom + GAP;
			// Flip vertically when the preferred side has no room.
			if (top + panel.height > window.innerHeight - MARGIN) top = anchor.top - panel.height - GAP;
			if (top < MARGIN) top = anchor.bottom + GAP;
			left = Math.min(Math.max(MARGIN, left), window.innerWidth - panel.width - MARGIN);
			top = Math.min(Math.max(MARGIN, top), window.innerHeight - panel.height - MARGIN);
			setPosition({ left, top });
		};
		place();
		window.addEventListener("resize", place);
		return () => window.removeEventListener("resize", place);
	}, [open, placement, anchorRef]);

	useEffect(() => {
		if (!open) return;
		const panel = panelRef.current;
		const unregisterLayer = registerDialogLayer(panel);
		(panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();
		const onDown = (event: PointerEvent) => {
			const target = event.target as globalThis.Node | null;
			if (panel?.contains(target) || anchorRef.current?.contains(target)) return;
			onCloseRef.current();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || isImeKeyEvent(event) || !isTopmostDialog(panel)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			onCloseRef.current();
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey, true);
			const hadFocus = panel?.contains(document.activeElement) ?? false;
			unregisterLayer();
			if (hadFocus || document.activeElement === document.body) anchorRef.current?.focus();
		};
	}, [open, anchorRef]);

	if (!open) return null;
	return createPortal(
		<div
			aria-label={ariaLabel}
			aria-modal={false}
			className="omp-pop-in fixed z-(--sc-z-popover) outline-none"
			ref={panelRef}
			role="dialog"
			// Unpositioned first frame: transparent rather than hidden, so focus can land inside.
			style={position ?? { left: 0, top: 0, opacity: 0 }}
			tabIndex={-1}
		>
			<PopoverSurface className={className}>{children}</PopoverSurface>
		</div>,
		document.body,
	);
}
