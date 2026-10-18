/**
 * The composer's phone sheet: the production action sheet (`omp-action-sheet*`, the same grabber and surface as
 * `Popover` on a phone) minus the focus theft. Nothing inside it takes focus and every press inside keeps it where it
 * was, so a sheet opened from a status chip with the soft keyboard up leaves the keyboard up, and one opened with the
 * keyboard down never raises it. The scrim closes it; Esc, the back gesture and a pull on the grabber do too. It is
 * `aria-modal="false" ` on purpose: the field behind stays reachable. If the field held focus when the sheet opened and
 * focus fell to the page while it closed, the field gets it back.
 */
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../../../hooks/use-back-layer";
import { cx } from "../../../lib/format";
import { isImeKeyEvent } from "../../../lib/ime";
import { PopoverSurface } from "../../common/Popover";
import { SheetHandle } from "../../common/Sheet";
import { keepFocus } from "./keep-focus";

export function ComposerSheet({
	open,
	onClose,
	label,
	children,
	className,
}: {
	open: boolean;
	onClose: () => void;
	label: string;
	children: ReactNode;
	className?: string;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useBackLayer(open, onClose);
	useEffect(() => {
		if (!open) return;
		const fieldHadFocus = document.activeElement?.matches("[data-composer-input]") === true;
		const field = fieldHadFocus ? (document.activeElement as HTMLElement) : null;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || isImeKeyEvent(event)) return;
			event.preventDefault();
			event.stopPropagation();
			closeRef.current();
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			if (field?.isConnected && (!document.activeElement || document.activeElement === document.body)) field.focus();
		};
	}, [open]);
	if (!open) return null;
	return createPortal(
		<div
			{...keepFocus}
			className="omp-action-sheet-overlay omp-fade-in"
			data-action-sheet=""
			data-composer-sheet=""
			onClick={event => {
				if (event.target === event.currentTarget) onClose();
			}}
			role="presentation"
		>
			<div
				aria-label={label}
				aria-modal="false"
				className="omp-action-sheet omp-sheet-in-bottom outline-none"
				ref={panelRef}
				role="dialog"
			>
				<SheetHandle onClose={onClose} panelRef={panelRef} />
				<PopoverSurface className={cx("omp-action-sheet-surface", className)}>{children}</PopoverSurface>
			</div>
		</div>,
		document.body,
	);
}
