/**
 * Dialog (`Modal`) — a centered, modal layer. Backdrop click and Escape
 * close; focus is trapped while open and restored to the opener on close.
 *
 * Container policy (components/common/README.md): dialogs are for SHORT, self-contained
 * tasks — confirm, rename, a small form (size sm/md) — and for pickers
 * (size "picker", placement "top": commands, model, session, branch,
 * theme). Destinations with navigation of their own (Settings, Insights,
 * Agents, PRs) are full pages, not dialogs; contextual detail is the
 * inspector side panel or a Sheet. Never open a dialog from a dialog: swap
 * the content in place or close the first. Sizes lg/full are legacy.
 * `footer` holds the actions, primary last (rightmost).
 */

import { X } from "lucide-react";
import {
	type CSSProperties,
	forwardRef,
	type HTMLAttributes,
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { useScrollOverflow } from "../../hooks/use-scroll-overflow";
import { useShellMode } from "../../hooks/use-shell-mode";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IconButton } from "./IconButton";
import { SheetHandle } from "./Sheet";
import { useModalLayer } from "./use-modal-layer";

export type ModalSize = "sm" | "md" | "lg" | "full" | "picker" | "picker-compact";

/**
 * Overlay alignment: centered (default), top-anchored (command-palette style), or `above` the box `anchor` names
 * (the model picker over its composer), its right edge on the box's.
 */
export type ModalPlacement = "center" | "top" | "above";

/** The viewport box a dialog placed `above` sits on (`getBoundingClientRect`'s top and right). */
export interface ModalAnchor {
	top: number;
	right: number;
}

const SIZE_CLASSES: Record<ModalSize, string> = {
	sm: "omp-dialog-size-sm",
	md: "omp-dialog-size-md",
	lg: "omp-dialog-size-lg",
	full: "omp-dialog-size-full",
	picker: "omp-dialog-size-picker",
	"picker-compact": "omp-dialog-size-picker-compact",
};

export interface DialogSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
	title?: ReactNode;
	titleId?: string;
	description?: ReactNode;
	descriptionId?: string;
	/** Renders the close button in the header when set. */
	onClose?: () => void;
	chromeless?: boolean;
	bodyClassName?: string;
	footer?: ReactNode;
	/** Drag handle above the header (a dialog shown as a sheet). */
	handle?: ReactNode;
}

const BODY_FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog panel: header (title + description + close), scrolling body,
 * optional right-aligned footer. Long titles and action rows wrap.
 * Modal renders it as the dialog element; the style guide renders it inline.
 */
export const DialogSurface = forwardRef<HTMLDivElement, DialogSurfaceProps>(function DialogSurface(
	{
		title,
		titleId,
		description,
		descriptionId,
		onClose,
		chromeless,
		bodyClassName = "omp-body-pad px-5 py-4",
		handle,
		footer,
		className,
		children,
		...rest
	},
	ref,
) {
	const t = useT();
	// A body that scrolls and holds nothing focusable (a changelog, a long notice) takes a tab stop of its own, or
	// the keyboard could never scroll what it hides (axe scrollable-region-focusable).
	const bodyRef = useRef<HTMLDivElement>(null);
	const overflow = useScrollOverflow(bodyRef, children);
	const [plainText, setPlainText] = useState(false);
	useLayoutEffect(() => {
		setPlainText(!bodyRef.current?.querySelector(BODY_FOCUSABLE));
	});
	return (
		<div
			className={cx(
				"flex flex-col overflow-hidden rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-lg)",
				className,
			)}
			ref={ref}
			{...rest}
		>
			{handle}
			{!chromeless && (
				<div className="omp-dialog-head flex min-h-13 shrink-0 items-start justify-between gap-3 py-3 pr-3 pl-5">
					<div className="min-w-0 pt-0.5">
						<h2 className="text-sc-xl font-semibold tracking-(--sc-tracking-tight) break-words" id={titleId}>
							{title}
						</h2>
						{description && (
							<p className="mt-1 text-sc-sm leading-relaxed text-(--sc-text-muted)" id={descriptionId}>
								{description}
							</p>
						)}
					</div>
					{onClose && (
						<IconButton icon={<X />} label={t("common.close")} onClick={onClose} size="sm" tooltip={false} />
					)}
				</div>
			)}
			<div
				className={cx("omp-dialog-body min-h-0 flex-1 overflow-y-auto", bodyClassName)}
				ref={bodyRef}
				tabIndex={overflow.y && plainText ? 0 : undefined}
			>
				{children}
			</div>
			{footer && (
				<div className="omp-dialog-foot flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-(--sc-divider) px-5 py-3">
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
	/** Short supporting copy below the title, associated with the dialog. */
	description?: ReactNode;
	size?: ModalSize;
	/** Hide the title bar entirely (chromeless dialogs like the command palette). */
	chromeless?: boolean;
	/** Overlay alignment: centered (default), top-anchored picker style, or above `anchor`. */
	placement?: ModalPlacement;
	/** For placement `above`: the box to sit on. Without one the dialog falls back to `top`. */
	anchor?: ModalAnchor | null;
	/** Dim and blur what is behind the dialog (default). Off: the window stays as it is; a click outside still closes. */
	backdrop?: boolean;
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
	/**
	 * Scope the layer to this element instead of the whole window: the overlay
	 * covers only it (`absolute inset-0`; the element must be positioned). Unset
	 * or null = the window.
	 */
	container?: HTMLElement | null;
	children: ReactNode;
}

export function Modal({
	open,
	onClose,
	title,
	description,
	size = "md",
	chromeless,
	placement = "center",
	anchor,
	backdrop = true,
	ariaLabel,
	panelClassName,
	bodyClassName = "omp-body-pad px-5 py-4",
	footer,
	container,
	children,
}: ModalProps) {
	const titleId = useId();
	const descriptionId = useId();
	const panelRef = useRef<HTMLDivElement>(null);
	// Exit phase lives in the shared overlay-presence hook: `mounted` — not `open` —
	// gates the portal, the phase starts in the SAME commit's effect while the panel
	// is still in the DOM, and reduced motion skips straight to unmount.
	const { mounted, closing } = useOverlayPresence(open);

	// What actually animates out. A dialog whose payload clears on close rebuilds
	// its children from `null`, so the fading panel would collapse to an empty box;
	// holding the tree from the last open commit lets callers drop their own
	// `if (!payload) return null` gate and pass `open` instead.
	const shownRef = useRef<{
		ariaLabel?: string;
		body: ReactNode;
		description?: ReactNode;
		footer: ReactNode;
		title: ReactNode;
	} | null>(null);
	if (open) shownRef.current = { ariaLabel, body: children, description, footer, title };
	const shown = shownRef.current;

	useModalLayer(open, panelRef, onClose);
	// On a phone every dialog is a bottom sheet (mobile.css lays it out); a dialog scoped to a container stays put.
	const sheet = useShellMode() === "phone" && !container;

	// Render on the opening commit so the focus/layer effect sees a real panel.
	// `mounted` only extends the closing phase for the exit animation.
	if (!mounted || !shown) return null;
	const above = placement === "above" && anchor && !sheet && !container ? anchor : null;

	return createPortal(
		<div
			className={cx(
				"omp-dialog-overlay inset-0 z-(--sc-z-dialog) flex p-4",
				backdrop && "bg-(--sc-overlay) backdrop-blur-[2px]",
				container ? "absolute" : "fixed",
				closing ? "omp-fade-out" : "omp-fade-in",
				above
					? "omp-dialog-overlay--above items-end justify-end"
					: placement === "center"
						? "items-center justify-center"
						: "items-start justify-center pt-[12dvh]",
				sheet && "omp-dialog-overlay--sheet",
			)}
			style={
				above
					? ({
							paddingBottom: `${Math.max(16, window.innerHeight - above.top + 8)}px`,
							paddingRight: `${Math.max(16, window.innerWidth - above.right)}px`,
							"--omp-dialog-room": `${Math.max(160, above.top - 24)}px`,
						} as CSSProperties)
					: undefined
			}
			inert={closing}
			onMouseDown={event => {
				if (closing) return;
				if (event.target === event.currentTarget) onClose();
			}}
			role="presentation"
		>
			<DialogSurface
				aria-label={shown.ariaLabel ?? (typeof shown.title === "string" ? shown.title : undefined)}
				aria-describedby={!chromeless && shown.description ? descriptionId : undefined}
				aria-labelledby={!chromeless && shown.title ? titleId : undefined}
				aria-modal={!closing}
				bodyClassName={bodyClassName}
				chromeless={chromeless}
				description={shown.description}
				descriptionId={descriptionId}
				className={cx(
					"omp-dialog-panel",
					closing ? "omp-scale-out" : "omp-scale-in",
					SIZE_CLASSES[size],
					sheet && "omp-dialog-panel--sheet",
					panelClassName,
				)}
				data-chromeless={chromeless ? "" : undefined}
				data-presentation={sheet ? "sheet" : undefined}
				handle={sheet ? <SheetHandle onClose={onClose} panelRef={panelRef} /> : undefined}
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
		container ?? document.body,
	);
}
