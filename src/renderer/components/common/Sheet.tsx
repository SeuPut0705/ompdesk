/**
 * Sheet — a modal panel that slides in from a window edge over a scrim.
 *
 * Container policy (design-spec.md): use a Sheet for contextual detail that
 * needs more room than a popover but must not replace the page — the
 * inspector (changes, files, logs, queue, plan) when the window is too
 * narrow to dock it, a session's details, a filter panel. Same behavior as
 * Dialog: focus trapped, Escape and scrim click close, focus restored.
 * Never stack a Sheet on a Dialog or vice versa.
 *
 * `placement` picks the edge: `right` (default, the desktop inspector), `left`
 * (a drawer), `bottom` (an action or detail sheet, content-high) or `full` (a
 * full-screen sheet that still reads as a layer). Bottom and full sheets carry
 * a drag handle: pulling it down dismisses, and on the web shell the system
 * back gesture closes the topmost sheet.
 */

import { X } from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IconButton } from "./IconButton";
import { useModalLayer } from "./use-modal-layer";
import { useSheetDrag } from "./use-sheet-drag";

export type SheetSize = "sm" | "md" | "lg";
export type SheetPlacement = "right" | "bottom" | "left" | "full";

const WIDTH: Record<SheetSize, string> = {
	sm: "w-[min(360px,calc(100vw-48px))]",
	md: "w-[min(440px,calc(100vw-48px))]",
	lg: "w-[min(560px,calc(100vw-48px))]",
};

/** Panel geometry and the entrance per placement; the exit of the non-right ones is `omp-sheet-out` (mobile.css). */
const PLACEMENT: Record<SheetPlacement, { overlay: string; panel: string; enter: string; surface: string }> = {
	right: { overlay: "justify-end", panel: "h-full", enter: "omp-slide-in-right", surface: "border-l" },
	left: { overlay: "justify-start", panel: "h-full", enter: "omp-sheet-in-left", surface: "border-r" },
	bottom: {
		overlay: "items-end justify-center",
		panel: "w-full max-w-160",
		enter: "omp-sheet-in-bottom",
		surface: "omp-sheet-surface h-auto! max-h-[inherit] rounded-t-(--sc-radius-xl) border-t",
	},
	full: {
		overlay: "items-end justify-center",
		panel: "h-dvh w-full",
		enter: "omp-sheet-in-bottom",
		surface: "border-t pt-(--safe-t)",
	},
};

export interface SheetSurfaceProps {
	title: ReactNode;
	titleId?: string;
	description?: ReactNode;
	onClose?: () => void;
	footer?: ReactNode;
	className?: string;
	/** Body padding/layout; defaults to the standard inset. Pass e.g. "flex flex-col" for a full-bleed canvas. */
	bodyClassName?: string;
	/** Full custom chrome, while retaining the sheet's accessible title. */
	header?: ReactNode;
	/** Where the sheet sits; sets the surface's border and, for bottom/full, its rounded top. */
	placement?: SheetPlacement;
	/** A drag handle above the header; pulling it dismisses (bottom and full sheets). */
	handle?: ReactNode;
	children: ReactNode;
}

/** The grabber at a bottom sheet's top edge: pulling it toward the edge dismisses the sheet. */
export function SheetHandle({
	panelRef,
	onClose,
	edge = "bottom",
}: {
	panelRef: RefObject<HTMLElement | null>;
	onClose: () => void;
	edge?: "bottom" | "left";
}) {
	const t = useT();
	const handlers = useSheetDrag(panelRef, onClose, edge);
	return (
		<div
			aria-label={t("sheet.handle")}
			className="omp-sheet-handle"
			data-sheet-handle=""
			// Drag only: the close button and Escape stay the keyboard routes.
			role="presentation"
			{...handlers}
		>
			<span aria-hidden className="omp-sheet-grip" />
		</div>
	);
}

/** The sheet panel visuals: header, scrolling body, optional footer. */
export function SheetSurface({
	title,
	titleId,
	description,
	onClose,
	footer,
	className,
	bodyClassName = "px-5 py-4",
	children,
	header,
	placement = "right",
	handle,
}: SheetSurfaceProps) {
	const t = useT();
	return (
		<div
			className={cx(
				"flex h-full flex-col border-(--sc-border-subtle) bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-lg)",
				PLACEMENT[placement].surface,
				className,
			)}
		>
			{handle}
			{header ? (
				<>
					<span className="sr-only" id={titleId}>
						{title}
					</span>
					{header}
				</>
			) : (
				<div className="flex shrink-0 items-start justify-between gap-3 border-b border-(--sc-divider) py-3 pr-3 pl-5">
					<div className="min-w-0 pt-1">
						<div className="text-sc-lg font-semibold tracking-(--sc-tracking-tight) break-words" id={titleId}>
							{title}
						</div>
						{description && <div className="mt-0.5 text-sc-sm text-(--sc-text-muted)">{description}</div>}
					</div>
					{onClose && (
						<IconButton icon={<X />} label={t("common.close")} onClick={onClose} size="sm" tooltip={false} />
					)}
				</div>
			)}
			<div className={cx("min-h-0 flex-1 overflow-y-auto", bodyClassName)}>{children}</div>
			{footer && (
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-(--sc-divider) px-5 py-3">
					{footer}
				</div>
			)}
		</div>
	);
}

export interface SheetProps
	extends Omit<SheetSurfaceProps, "titleId" | "onClose" | "className" | "placement" | "handle"> {
	open: boolean;
	onClose: () => void;
	/** Width of a right or left sheet. */
	size?: SheetSize;
	placement?: SheetPlacement;
}

export function Sheet({ open, onClose, size = "md", placement = "right", ...surface }: SheetProps) {
	const titleId = useId();
	const panelRef = useRef<HTMLDivElement>(null);
	const { mounted, closing } = useOverlayPresence(open);
	useModalLayer(open, panelRef, onClose);
	if (!mounted) return null;
	const sideEdge = placement === "right" || placement === "left";
	const geometry = PLACEMENT[placement];
	return createPortal(
		<div
			className={cx(
				"fixed inset-0 z-(--sc-z-dialog) flex bg-(--sc-overlay) backdrop-blur-[2px]",
				geometry.overlay,
				closing ? "omp-fade-out" : "omp-fade-in",
			)}
			data-sheet-placement={placement}
			inert={closing}
			onMouseDown={event => {
				if (!closing && event.target === event.currentTarget) onClose();
			}}
			role="presentation"
		>
			<div
				aria-labelledby={titleId}
				aria-modal={!closing}
				className={cx(
					"outline-none",
					geometry.panel,
					sideEdge && WIDTH[size],
					placement === "bottom" && "max-h-[calc(100dvh-var(--safe-t)-1rem)]",
					closing ? placement !== "right" && "omp-sheet-out" : geometry.enter,
				)}
				data-sheet-panel=""
				ref={panelRef}
				role={closing ? "presentation" : "dialog"}
				tabIndex={-1}
			>
				<SheetSurface
					{...surface}
					handle={sideEdge ? undefined : <SheetHandle onClose={onClose} panelRef={panelRef} />}
					onClose={onClose}
					placement={placement}
					titleId={titleId}
				/>
			</div>
		</div>,
		document.body,
	);
}
