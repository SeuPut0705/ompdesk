/**
 * Sheet — a modal panel that slides in from a window edge over a scrim.
 *
 * Container policy (design-spec.md): use a Sheet for contextual detail that
 * needs more room than a popover but must not replace the page — the
 * inspector (changes, files, logs, queue, plan) when the window is too
 * narrow to dock it, a session's details, a filter panel. Same behavior as
 * Dialog: focus trapped, Escape and scrim click close, focus restored.
 * Never stack a Sheet on a Dialog or vice versa.
 * The header carries `.omp-sheet-header[data-side]` so the shell can keep a
 * left sheet's title clear of the macOS traffic lights (global.css).
 */

import { X } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IconButton } from "./IconButton";
import { useModalLayer } from "./use-modal-layer";

export type SheetSide = "right" | "left";
export type SheetSize = "sm" | "md" | "lg";

const WIDTH: Record<SheetSize, string> = {
	sm: "w-[min(360px,calc(100vw-48px))]",
	md: "w-[min(440px,calc(100vw-48px))]",
	lg: "w-[min(560px,calc(100vw-48px))]",
};

export interface SheetSurfaceProps {
	title: ReactNode;
	titleId?: string;
	description?: ReactNode;
	onClose?: () => void;
	side?: SheetSide;
	footer?: ReactNode;
	className?: string;
	/** Body padding/layout; defaults to the standard inset. Pass e.g. "flex flex-col" for a full-bleed canvas. */
	bodyClassName?: string;
	/** Full custom chrome, while retaining the sheet's accessible title. */
	header?: ReactNode;
	children: ReactNode;
}

/** The sheet panel visuals: header, scrolling body, optional footer. */
export function SheetSurface({
	title,
	titleId,
	description,
	onClose,
	side = "right",
	footer,
	className,
	bodyClassName = "px-5 py-4",
	children,
	header,
}: SheetSurfaceProps) {
	const t = useT();
	return (
		<div
			className={cx(
				"flex h-full flex-col bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-lg)",
				side === "right" ? "border-l border-(--sc-border-subtle)" : "border-r border-(--sc-border-subtle)",
				className,
			)}
		>
			{header ? (
				<>
					<span className="sr-only" id={titleId}>
						{title}
					</span>
					{header}
				</>
			) : (
				<div
					className="omp-sheet-header flex shrink-0 items-start justify-between gap-3 border-b border-(--sc-divider) py-3 pr-3 pl-5"
					data-side={side}
				>
					<div className="min-w-0 pt-1">
						<div className="truncate text-sc-lg font-semibold tracking-(--sc-tracking-tight)" id={titleId}>
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
				<div className="flex shrink-0 items-center justify-end gap-2 border-t border-(--sc-divider) px-5 py-3">
					{footer}
				</div>
			)}
		</div>
	);
}

export interface SheetProps extends Omit<SheetSurfaceProps, "titleId" | "onClose" | "className"> {
	open: boolean;
	onClose: () => void;
	size?: SheetSize;
}

export function Sheet({ open, onClose, size = "md", side = "right", ...surface }: SheetProps) {
	const titleId = useId();
	const panelRef = useRef<HTMLDivElement>(null);
	const { mounted, closing } = useOverlayPresence(open);
	useModalLayer(open, panelRef, onClose);
	if (!mounted) return null;
	return createPortal(
		<div
			className={cx(
				"fixed inset-0 z-(--sc-z-dialog) flex bg-(--sc-overlay) backdrop-blur-[2px]",
				side === "right" ? "justify-end" : "justify-start",
				closing ? "omp-fade-out" : "omp-fade-in",
			)}
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
					"h-full outline-none",
					WIDTH[size],
					!closing && (side === "right" ? "omp-slide-in-right" : "omp-slide-in-left"),
				)}
				ref={panelRef}
				role={closing ? "presentation" : "dialog"}
				tabIndex={-1}
			>
				<SheetSurface {...surface} onClose={onClose} side={side} titleId={titleId} />
			</div>
		</div>,
		document.body,
	);
}
