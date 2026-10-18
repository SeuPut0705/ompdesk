import { Check } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { PopoverSurface } from "../../../components/common/Popover";
import { SheetHandle } from "../../../components/common/Sheet";
import { useBackLayer } from "../../../hooks/use-back-layer";
import { cx } from "../../../lib/format";
import { isImeKeyEvent } from "../../../lib/ime";

/**
 * A press that must not move focus: the composer's field keeps the caret and the soft keyboard. `mousedown` only:
 * preventDefault on `pointerdown` also cancels the click in WebKit (measured, Playwright iPhone 15), so every control
 * would be dead on iOS. Chromium and WebKit both skip the focus move when the synthesized mousedown is cancelled.
 */
export const keepFocus = {
	onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
};

/**
 * The production action sheet (`omp-action-sheet*`, the same grabber and surface as `Popover` on a phone) minus the
 * focus theft: nothing inside it takes focus, every press inside keeps it in the composer's field, so a sheet opened
 * with the keyboard up leaves the keyboard up. The scrim closes it; Esc, the back gesture and a drag on the grabber do
 * too. `aria-modal` is false on purpose (the field stays reachable).
 */
export function ProtoSheet({
	open,
	onClose,
	label,
	children,
	onClosed,
	className,
}: {
	open: boolean;
	onClose: () => void;
	label: string;
	children: ReactNode;
	/** Runs after the sheet unmounted (the caller hands focus back to the field). */
	onClosed?: () => void;
	className?: string;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const closedRef = useRef(onClosed);
	closedRef.current = onClosed;
	useBackLayer(open, onClose);
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || isImeKeyEvent(event)) return;
			event.preventDefault();
			closeRef.current();
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			closedRef.current?.();
		};
	}, [open]);
	if (!open) return null;
	return createPortal(
		<div
			{...keepFocus}
			className="omp-action-sheet-overlay omp-fade-in"
			data-action-sheet=""
			data-proto-sheet=""
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
				style={{ ["--hit-gap-x" as string]: "0px", ["--hit-gap-y" as string]: "0px" }}
			>
				<SheetHandle onClose={onClose} panelRef={panelRef} />
				<PopoverSurface
					className={cx("omp-action-sheet-surface border-0 bg-transparent p-0 shadow-none", className)}
				>
					{children}
				</PopoverSurface>
			</div>
		</div>,
		document.body,
	);
}

export function SheetTitle({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-2 px-3 pb-1.5">
			<div className="min-w-0 truncate text-sc-md font-semibold text-(--sc-text)">{children}</div>
			{trailing}
		</div>
	);
}

/** One 44 px choice row (the action sheet's own `[data-menu-item]` minimum): the check shows the live value. */
export function OptionRow({
	label,
	description,
	checked,
	onSelect,
	icon,
	trailing,
}: {
	label: ReactNode;
	description?: ReactNode;
	checked?: boolean;
	onSelect: () => void;
	icon?: ReactNode;
	trailing?: ReactNode;
}) {
	return (
		<button
			aria-checked={checked}
			className={cx(
				"flex w-full items-center gap-3 rounded-(--sc-radius-md) px-3 py-1.5 text-left text-(--sc-text) hover:bg-(--sc-hover)",
				checked && "bg-(--sc-selected)",
			)}
			data-menu-item=""
			onClick={onSelect}
			role={checked === undefined ? "menuitem" : "menuitemradio"}
			type="button"
		>
			{icon && <span className="shrink-0 text-(--sc-text-muted) [&>svg]:size-(--sc-icon-md)">{icon}</span>}
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sc-lg">{label}</span>
				{description && <span className="block text-sc-sm text-(--sc-text-muted)">{description}</span>}
			</span>
			{trailing}
			{checked && <Check aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-accent)" />}
		</button>
	);
}

/** An exclusive choice as a row of segments: every option visible, one tap, nothing nested. */
export function Segmented<T extends string>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
}) {
	const id = useId();
	return (
		<div
			aria-label={label}
			className="flex gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-2) p-0.5"
			id={id}
			role="radiogroup"
			style={{ ["--hit-gap-x" as string]: "2px" }}
		>
			{options.map(option => (
				<button
					aria-checked={option.value === value}
					className={cx(
						"min-w-0 flex-1 rounded-(--sc-radius-sm) px-0.5 leading-tight transition-colors duration-(--sc-duration-fast)",
						options.length > 4 ? "text-sc-sm" : "text-sc-md",
						"min-h-11",
						option.value === value
							? "bg-(--sc-elevated) font-medium text-(--sc-text) shadow-(--sc-shadow-sm)"
							: "text-(--sc-text-muted) hover:text-(--sc-text)",
					)}
					key={option.value}
					onClick={() => onChange(option.value)}
					role="radio"
					type="button"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
