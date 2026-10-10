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
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { isImeKeyEvent } from "../../lib/ime";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { IconButton } from "./IconButton";
import { Kbd } from "./Kbd";

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

interface ContextMenuProps {
	items: ContextMenuItem[];
	/** Viewport x of the menu's left edge (align "start") or right edge (align "end"). */
	x: number;
	y: number;
	align?: MenuAlign;
	ariaLabel?: string;
	onClose: () => void;
}

/** Menu panel visuals. */
export function MenuSurface({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<div
			className={cx(
				"min-w-48 max-w-[min(20rem,calc(100vw-1rem))] max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-1 shadow-(--sc-shadow-md)",
				className,
			)}
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
			{showCheckColumn ? (
				<Check
					aria-hidden
					className={cx("size-(--sc-icon-sm) shrink-0 text-(--sc-text-secondary)", !item.checked && "invisible")}
				/>
			) : (
				Icon && (
					<Icon
						aria-hidden
						className={cx(
							"size-(--sc-icon-sm) shrink-0",
							item.danger ? "text-(--sc-danger)" : "text-(--sc-text-muted)",
						)}
					/>
				)
			)}
			<span className="min-w-0 flex-1">
				<span className="block truncate">{item.label}</span>
				{item.description && (
					<span className="mt-0.5 block text-sc-xs font-normal text-(--sc-text-muted)">{item.description}</span>
				)}
			</span>
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

export function ContextMenu({ items, x, y, align = "start", ariaLabel, onClose }: ContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [activeIndex, setActiveIndex] = useState(() => items.findIndex(item => !item.disabled));
	const [pos, setPos] = useState({ left: x, top: y });

	// Clamp inside the viewport once mounted (menu height is content-driven).
	useLayoutEffect(() => {
		const el = menuRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const left = Math.min(align === "end" ? x - rect.width : x, window.innerWidth - rect.width - 8);
		const top = Math.min(y, window.innerHeight - rect.height - 8);
		setPos({ left: Math.max(8, left), top: Math.max(8, top) });
	}, [x, y, align]);

	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		// Restore focus to the element that opened the menu — unmounting the
		// focused item otherwise drops focus to <body>. The restore runs ONLY
		// on unmount (onClose is read through a ref): re-running per render
		// would steal focus back to the trigger while the menu stays open.
		const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const onDown = (event: PointerEvent) => {
			// The trigger opens this menu from `click`, so its preceding pointerdown
			// has already finished before this effect is installed. Listening for the
			// next pointer press avoids treating the opening click itself as an
			// outside dismissal while still closing before a later outside click.
			if (!menuRef.current?.contains(event.target as globalThis.Node | null)) onCloseRef.current();
		};
		const onKey = (event: KeyboardEvent) => {
			if (isImeKeyEvent(event)) return;
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
			if (restore?.isConnected) restore.focus();
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

	return createPortal(
		<div
			aria-label={ariaLabel}
			className="omp-pop-in fixed z-(--sc-z-popover)"
			onKeyDown={event => {
				if (event.key === "Escape") {
					event.preventDefault();
					// The menu owns this keypress: without stopping it, a dialog behind
					// the menu takes the same Escape and closes with it.
					event.stopPropagation();
					onClose();
				} else if (event.key === "ArrowDown") {
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
			}}
			ref={menuRef}
			role="menu"
			style={{ left: pos.left, top: pos.top }}
		>
			<MenuSurface className={items.some(item => item.description) ? "min-w-64" : undefined}>
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
	disabled,
	className,
}: MenuButtonProps) {
	const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);
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
			setAnchor({ x: align === "end" ? rect.right : rect.left, y: rect.bottom + 4 });
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
					align={align}
					ariaLabel={label}
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
