/**
 * Dialog (`Modal`) — a centered, modal layer. Backdrop click and Escape
 * close; focus is trapped while open and restored to the opener on close.
 *
 * Container policy (design-spec.md): dialogs are for SHORT, self-contained
 * tasks — confirm, rename, a small form (size sm/md) — and for pickers
 * (size "picker", placement "top": commands, model, session, branch,
 * theme). Destinations with navigation of their own (Settings, Insights,
 * Agents, PRs) are full pages, not dialogs; contextual detail is the
 * inspector side panel or a Sheet. Never open a dialog from a dialog: swap
 * the content in place or close the first. Sizes lg/full are legacy.
 * `footer` holds the actions, primary last (rightmost).
 */

import { X } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IconButton } from "./IconButton";
import { useModalLayer } from "./use-modal-layer";

export type ModalSize = "sm" | "md" | "lg" | "full" | "picker";

/** Overlay alignment: centered (default) or top-anchored (command-palette style). */
export type ModalPlacement = "center" | "top";

const SIZE_CLASSES: Record<ModalSize, string> = {
	sm: "omp-dialog-size-sm",
	md: "omp-dialog-size-md",
	lg: "omp-dialog-size-lg",
	full: "omp-dialog-size-full",
	picker: "omp-dialog-size-picker",
};

export interface DialogSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
	title?: ReactNode;
	titleId?: string;
	/** Renders the close button in the header when set. */
	onClose?: () => void;
	chromeless?: boolean;
	bodyClassName?: string;
	footer?: ReactNode;
}

/**
 * The dialog panel: header (title + close), scrolling body, optional footer.
 * Modal renders it as the dialog element; the style guide renders it inline.
 */
export const DialogSurface = forwardRef<HTMLDivElement, DialogSurfaceProps>(function DialogSurface(
	{ title, titleId, onClose, chromeless, bodyClassName = "px-5 py-4", footer, className, children, ...rest },
	ref,
) {
	const t = useT();
	return (
		<div
			className={cx(
				"flex flex-col overflow-hidden rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-lg)",
				className,
			)}
			ref={ref}
			{...rest}
		>
			{!chromeless && (
				<div className="flex min-h-13 shrink-0 items-center justify-between gap-3 py-2.5 pr-3 pl-5">
					<div className="min-w-0 truncate text-sc-lg font-semibold tracking-(--sc-tracking-tight)" id={titleId}>
						{title}
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
});

export interface ModalProps {
	open: boolean;
	onClose: () => void;
	title?: ReactNode;
	size?: ModalSize;
	/** Hide the title bar entirely (chromeless dialogs like the command palette). */
	chromeless?: boolean;
	/** Overlay alignment: centered (default) or top-anchored picker style. */
	placement?: ModalPlacement;
	/** Accessible name for the dialog (required when chromeless — no visible title). */
	ariaLabel?: string;
	/** Extra classes for the panel. */
	panelClassName?: string;
	/**
	 * Body container classes. Defaults to `px-5 py-4` so the body aligns with the
	 * title (also inset 20px). Pass "p-0" for dialogs that manage their own inner
	 * layout (Settings, chromeless pickers, tree/hub windows).
	 */
	bodyClassName?: string;
	/** Action row pinned under the body; primary action last. */
	footer?: ReactNode;
	children: ReactNode;
}

export function Modal({
	open,
	onClose,
	title,
	size = "md",
	chromeless,
	placement = "center",
	ariaLabel,
	panelClassName,
	bodyClassName = "px-5 py-4",
	footer,
	children,
}: ModalProps) {
	const titleId = useId();
	const panelRef = useRef<HTMLDivElement>(null);
	// Exit phase lives in the shared overlay-presence hook: `mounted` — not `open` —
	// gates the portal, the phase starts in the SAME commit's effect while the panel
	// is still in the DOM, and reduced motion skips straight to unmount.
	const { mounted, closing } = useOverlayPresence(open);

	// What actually animates out. A dialog whose payload clears on close rebuilds
	// its children from `null`, so the fading panel would collapse to an empty box;
	// holding the tree from the last open commit lets callers drop their own
	// `if (!payload) return null` gate and pass `open` instead.
	const shownRef = useRef<{ ariaLabel?: string; body: ReactNode; footer: ReactNode; title: ReactNode } | null>(null);
	if (open) shownRef.current = { ariaLabel, body: children, footer, title };
	const shown = shownRef.current;

	useModalLayer(open, panelRef, onClose);

	// Render on the opening commit so the focus/layer effect sees a real panel.
	// `mounted` only extends the closing phase for the exit animation.
	if (!mounted || !shown) return null;

	return createPortal(
		<div
			className={cx(
				"omp-dialog-overlay fixed inset-0 z-(--sc-z-dialog) flex justify-center bg-(--sc-overlay) p-4 backdrop-blur-[2px]",
				closing ? "omp-fade-out" : "omp-fade-in",
				placement === "top" ? "items-start pt-[12dvh]" : "items-center",
			)}
			inert={closing}
			onMouseDown={event => {
				if (closing) return;
				if (event.target === event.currentTarget) onClose();
			}}
			role="presentation"
		>
			<DialogSurface
				aria-label={shown.ariaLabel ?? (typeof shown.title === "string" ? shown.title : undefined)}
				aria-labelledby={!chromeless && shown.title ? titleId : undefined}
				aria-modal={!closing}
				bodyClassName={bodyClassName}
				chromeless={chromeless}
				className={cx(
					"omp-dialog-panel",
					closing ? "omp-scale-out" : "omp-scale-in",
					SIZE_CLASSES[size],
					panelClassName,
				)}
				footer={shown.footer}
				onClose={onClose}
				onKeyDown={event => {
					if (event.key === "Escape") event.stopPropagation();
				}}
				ref={panelRef}
				// An exiting panel drops out of the dialog role: isTopmostDialog's
				// DOM fallback must not treat the animating portal as a covering
				// layer, or Escape cannot reach the dialog beneath.
				role={closing ? "presentation" : "dialog"}
				tabIndex={-1}
				title={shown.title}
				titleId={titleId}
			>
				{shown.body}
			</DialogSurface>
		</div>,
		document.body,
	);
}
