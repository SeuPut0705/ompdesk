/**
 * Menus — a short list of ACTIONS (or toggles) that closes on choice.
 *
 * - `ContextMenu`: portal-rendered at cursor/trigger coordinates, with full
 *   keyboard support (arrows navigate, Enter selects, Escape closes) and
 *   outside-press dismissal. Right-click surfaces open it at the pointer
 *   (anchorFromEvent).
 * - `MenuButton`: a button that opens the same menu under itself (⋯ menus,
 *   "more actions", overflow toolbars).
 * - `MenuSurface` / `MenuItemView`: the visuals, for the style guide.
 *
 * Rules: ≤ ~10 items, verbs first; destructive items last and `danger`;
 * shortcuts via `shortcut` (rendered as Kbd), never inside the label; items
 * that toggle a setting set `checked` (menuitemcheckbox). Choosing a value
 * from data (models, sessions) is a picker, not a menu; a form value with
 * few static options is a Select.
 */

import { Check, type LucideIcon } from "lucide-react";
import {
	type CSSProperties,
	Fragment,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../../hooks/use-back-layer";
import { useShellInput } from "../../hooks/use-shell-mode";
import { cx } from "../../lib/format";
import { isImeKeyEvent } from "../../lib/ime";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { isTopmostDialog, registerDialogLayer } from "./dialog-layer";
import { IconButton } from "./IconButton";
import { Kbd } from "./Kbd";
import { SheetHandle } from "./Sheet";

export interface ContextMenuItem {
	/** Stable id for keyboard focus tracking. */
	id: string;
	label: string;
	description?: string;
	icon?: LucideIcon;
	/** Right-aligned plain hint text (a count, a value). */
	hint?: string;
	/** macOS-spelled shortcut, rendered as Kbd. */
	shortcut?: string;
	/** Toggle item: renders a check and role="menuitemcheckbox". */
	checked?: boolean;
	/** Danger styling (destructive actions like delete). */
	danger?: boolean;
	/** Disabled items render but never fire. */
	disabled?: boolean;
	disabledReason?: string;
	/** Starts a new group: a divider renders above this item (ignored on the first). */
	separatorBefore?: boolean;
	onSelect: () => void;
}

export type MenuAlign = "start" | "end";
export type MenuSide = "above" | "below";

interface ContextMenuProps {
	items: ContextMenuItem[];
	/** Viewport x of the menu's left edge (align "start") or right edge (align "end"). */
	x: number;
	y: number;
	/** Viewport y the menu's bottom edge may rest on when it does not fit below `y` (its trigger's top). */
	above?: number;
	align?: MenuAlign;
	ariaLabel?: string;
	side?: MenuSide;
	onClose: () => void;
}

/** Menu panel visuals. */
export function MenuSurface({
	className,
	style,
	children,
}: {
	className?: string;
	style?: CSSProperties;
	children: ReactNode;
}) {
	return (
		<div
			className={cx(
				"min-w-48 max-w-[min(20rem,calc(100vw-1rem))] max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-1 shadow-(--sc-shadow-md)",
				className,
			)}
			style={style}
		>
			{children}
		</div>
	);
}

/** Inner layout of one menu item (icon or check · label + description · hint/shortcut). */
export function MenuItemView({ item }: { item: Omit<ContextMenuItem, "onSelect" | "id"> }) {
	const Icon = item.icon;
	const showCheckColumn = item.checked !== undefined;
	return (
		<>
			{Icon && (
				<Icon
					aria-hidden
					className={cx(
						"size-(--sc-icon-sm) shrink-0",
						item.danger ? "text-(--sc-danger)" : "text-(--sc-text-muted)",
					)}
				/>
			)}
			<span className="min-w-0 flex-1">
				<span className="block truncate">{item.label}</span>
				{item.description && (
					<span className="mt-0.5 block text-sc-xs font-normal text-(--sc-text-muted)">{item.description}</span>
				)}
			</span>
			{showCheckColumn && (
				<Check
					aria-hidden
					className={cx("size-(--sc-icon-sm) shrink-0 text-(--sc-text-secondary)", !item.checked && "invisible")}
				/>
			)}
			{item.hint && <span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{item.hint}</span>}
			{item.shortcut && <Kbd shortcut={item.shortcut} />}
		</>
	);
}

/** Item row classes; `active` is the keyboard/pointer highlight. */
export function menuItemClasses(item: Pick<ContextMenuItem, "danger" | "disabled">, active: boolean): string {
	return cx(
		"flex min-h-9 w-full items-center gap-2.5 rounded-(--sc-radius-md) px-2.5 py-1.5 text-left text-sc-md",
		item.danger ? "text-(--sc-danger)" : "text-(--sc-text)",
		active && (item.danger ? "bg-(--sc-danger-soft)" : "bg-(--sc-selected)"),
		item.disabled && "cursor-not-allowed opacity-50",
	);
}

export function ContextMenu({
	items,
	x,
	y,
	above,
	align = "start",
	side = "below",
	ariaLabel,
	onClose,
}: ContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const sheet = useShellInput() === "touch";
	// The system back gesture dismisses the sheet.
	useBackLayer(sheet, onClose);
	const [activeIndex, setActiveIndex] = useState(() => items.findIndex(item => !item.disabled));

	// Place inside the viewport before paint (menu size is content-driven). It
	// renders at the origin first so its width is never squeezed by the space
	// right of the anchor, and is measured by its layout box: the pop-in
	// animation starts scaled down, and a scaled measure lets the grown menu
	// overrun the edge. React never rewrites the constant origin style, so the
	// position set here stands.
	useLayoutEffect(() => {
		const el = menuRef.current;
		if (!el || sheet) return;
		el.style.left = "0px";
		el.style.top = "0px";
		// DOMs without layout (linkedom) leave these undefined: treat as 0.
		const { offsetWidth: width = 0, offsetHeight: height = 0 } = el;
		const left = Math.min(align === "end" ? x - width : x, window.innerWidth - width - 8);
		const fitsBelow = y + height <= window.innerHeight - 8;
		const top =
			(side === "above" || !fitsBelow) && above !== undefined && above - height >= 8
				? above - height
				: Math.min(y, window.innerHeight - height - 8);
		el.style.left = `${Math.max(8, left)}px`;
		el.style.top = `${Math.max(8, top)}px`;
	}, [x, y, above, align, side, sheet]);

	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		// Restore focus to the element that opened the menu — unmounting the
		// focused item otherwise drops focus to <body>. The restore runs ONLY
		// on unmount (onClose is read through a ref): re-running per render
		// would steal focus back to the trigger while the menu stays open. An
		// item that moved focus on purpose (a picker or overlay it opened, which
		// focused its own field as it mounted) keeps it.
		const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const panel = menuRef.current;
		const unregisterLayer = registerDialogLayer(panel);
		const onDown = (event: PointerEvent) => {
			// The trigger opens this menu from `click`, so its preceding pointerdown
			// has already finished before this effect is installed. Listening for the
			// next pointer press avoids treating the opening click itself as an
			// outside dismissal while still closing before a later outside click.
			if (!menuRef.current?.contains(event.target as globalThis.Node | null)) onCloseRef.current();
		};
		const onKey = (event: KeyboardEvent) => {
			if (isImeKeyEvent(event) || !isTopmostDialog(panel)) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				onCloseRef.current();
				return;
			}
			// Tab leaves an open menu for background controls while it stays
			// visible — close instead, per menu-button behavior.
			if (event.key === "Tab") {
				event.preventDefault();
				onCloseRef.current();
			}
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey, true);
			unregisterLayer();
			const focused = document.activeElement;
			const dropped = !focused || focused === document.body || panel?.contains(focused) === true;
			if (dropped && restore?.isConnected) restore.focus();
		};
	}, []);

	// Focus the active item whenever the menu opens or the index moves.
	useEffect(() => {
		menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]")[activeIndex]?.focus();
	}, [activeIndex]);

	const step = (delta: number) => {
		setActiveIndex(current => {
			for (let i = 1; i <= items.length; i++) {
				const next = (current + delta * i + items.length) % items.length;
				if (!items[next]?.disabled) return next;
			}
			return current;
		});
	};

	const list = (
		<MenuSurface
			className={sheet ? "omp-action-sheet-list" : items.some(item => item.description) ? "min-w-64" : undefined}
			style={side === "above" && !sheet ? { maxHeight: "min(60vh, calc(100dvh - 1rem))" } : undefined}
		>
			{items.map((item, index) => (
				<Fragment key={item.id}>
					{item.separatorBefore && index > 0 && (
						<div className="mx-2 my-1 h-px bg-(--sc-divider)" role="separator" />
					)}
					<button
						aria-checked={item.checked}
						className={menuItemClasses(item, index === activeIndex)}
						data-menu-item
						disabled={item.disabled}
						onClick={() => {
							if (item.disabled) return;
							item.onSelect();
						}}
						onMouseEnter={() => setActiveIndex(index)}
						role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
						title={item.disabled ? item.disabledReason : item.label}
						type="button"
					>
						<MenuItemView item={item} />
					</button>
				</Fragment>
			))}
		</MenuSurface>
	);
	const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			step(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			step(-1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const item = items[activeIndex];
			if (item && !item.disabled) item.onSelect();
		}
	};

	// A finger opened it (long press, ⋯): a bottom action sheet with 48 px rows, not a popover at the fingertip.
	if (sheet) {
		return createPortal(
			<div className="omp-action-sheet-overlay omp-fade-in" data-action-sheet="" role="presentation">
				<div
					aria-label={ariaLabel}
					className="omp-action-sheet omp-sheet-in-bottom"
					onKeyDown={onMenuKeyDown}
					ref={menuRef}
					role="menu"
				>
					<SheetHandle onClose={onClose} panelRef={menuRef} />
					{list}
				</div>
			</div>,
			document.body,
		);
	}
	return createPortal(
		<div
			aria-label={ariaLabel}
			className="omp-pop-in fixed z-(--sc-z-popover)"
			onKeyDown={onMenuKeyDown}
			ref={menuRef}
			role="menu"
			style={{ left: 0, top: 0 }}
		>
			{list}
		</div>,
		document.body,
	);
}

/** Cursor-anchored menu state for right-click surfaces. */
export interface ContextMenuAnchor {
	x: number;
	y: number;
}

export function anchorFromEvent(event: {
	clientX: number;
	clientY: number;
	preventDefault(): void;
}): ContextMenuAnchor {
	event.preventDefault();
	return { x: event.clientX, y: event.clientY };
}

export interface MenuButtonProps {
	items: ContextMenuItem[];
	/** Accessible name of the trigger (and the menu). */
	label: string;
	/** Icon-only trigger when set without `children`. */
	icon?: ReactNode;
	/** Visible trigger text; renders a Button. */
	children?: ReactNode;
	variant?: ButtonVariant;
	size?: ButtonSize;
	/** Which trigger edge the menu lines up with. */
	align?: MenuAlign;
	/** `above` opens over the trigger (capped at 60vh) when it fits; `below` is the default. */
	side?: MenuSide;
	disabled?: boolean;
	className?: string;
}

/**
 * A trigger that opens a ContextMenu below itself. Selecting an item closes
 * the menu and returns focus to the trigger.
 */
export function MenuButton({
	items,
	label,
	icon,
	children,
	variant,
	size = "md",
	align = "start",
	side = "below",
	disabled,
	className,
}: MenuButtonProps) {
	const [anchor, setAnchor] = useState<(ContextMenuAnchor & { above: number }) | null>(null);
	// A press on the trigger while open closes the menu (outside press); the
	// click that follows must not reopen it.
	const swallowClickRef = useRef(false);
	const open = anchor !== null;
	const triggerProps = {
		"aria-expanded": open,
		"aria-haspopup": "menu" as const,
		className,
		disabled,
		onPointerDown: () => {
			swallowClickRef.current = open;
		},
		onClick: (event: { currentTarget: HTMLElement }) => {
			if (swallowClickRef.current) {
				swallowClickRef.current = false;
				return;
			}
			const rect = event.currentTarget.getBoundingClientRect();
			setAnchor({ x: align === "end" ? rect.right : rect.left, y: rect.bottom + 4, above: rect.top - 4 });
		},
	};
	return (
		<>
			{children === undefined ? (
				<IconButton {...triggerProps} icon={icon} label={label} size={size} variant={variant ?? "ghost"} />
			) : (
				<Button {...triggerProps} aria-label={label} icon={icon} size={size} variant={variant ?? "secondary"}>
					{children}
				</Button>
			)}
			{anchor && (
				<ContextMenu
					above={anchor.above}
					align={align}
					ariaLabel={label}
					side={side}
					items={items.map(item => ({
						...item,
						onSelect: () => {
							setAnchor(null);
							item.onSelect();
						},
					}))}
					onClose={() => setAnchor(null)}
					x={anchor.x}
					y={anchor.y}
				/>
			)}
		</>
	);
}
