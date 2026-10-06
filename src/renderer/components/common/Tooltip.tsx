/**
 * Tooltip — a short label for a control whose meaning is not spelled out
 * (icon buttons, truncated text, chips). Shows after a hover delay or at
 * once on keyboard focus; Escape, blur, pointer leave or press hide it.
 *
 * Rules: one line of plain text plus an optional shortcut; never the only
 * place essential information or actions live (it is invisible on touch and
 * to most screen-reader users). Prefer IconButton, which wires this up.
 * `describe` links the text as the trigger's accessible description — turn it
 * off when the text repeats the trigger's accessible name.
 */

import {
	cloneElement,
	type FocusEvent,
	type HTMLAttributes,
	type PointerEvent,
	type ReactElement,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { formatShortcut } from "../../lib/keymap";

export type TooltipSide = "top" | "bottom" | "left" | "right";

const SHOW_DELAY_MS = 450;
const GAP = 6;
const MARGIN = 8;

export interface TooltipBubbleProps {
	id?: string;
	content: ReactNode;
	/** macOS-spelled shortcut, formatted for the platform. */
	shortcut?: string;
	className?: string;
	style?: HTMLAttributes<HTMLDivElement>["style"];
}

/** The tooltip surface itself (inverted, compact). Tooltip positions it; the style guide renders it inline. */
export function TooltipBubble({ id, content, shortcut, className, style }: TooltipBubbleProps) {
	return (
		<div
			className={cx(
				"pointer-events-none w-max max-w-72 rounded-(--sc-radius-sm) bg-(--sc-text) px-2 py-1 text-sc-xs font-medium text-(--sc-bg) shadow-(--sc-shadow-md)",
				className,
			)}
			id={id}
			role="tooltip"
			style={style}
		>
			{content}
			{shortcut && <span className="ml-2 font-normal opacity-70">{formatShortcut(shortcut)}</span>}
		</div>
	);
}

type TriggerProps = HTMLAttributes<HTMLElement>;

export interface TooltipProps {
	content: ReactNode;
	shortcut?: string;
	side?: TooltipSide;
	/** Expose the text as the trigger's aria-describedby (default true). */
	describe?: boolean;
	/** A single element that accepts pointer/focus handlers (a button, usually). */
	children: ReactElement<TriggerProps>;
}

export function Tooltip({ content, shortcut, side = "top", describe = true, children }: TooltipProps) {
	const id = useId();
	const [anchor, setAnchor] = useState<HTMLElement | null>(null);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	const bubbleRef = useRef<HTMLDivElement>(null);
	const timerRef = useRef<number | undefined>(undefined);

	const hide = () => {
		clearTimeout(timerRef.current);
		setAnchor(null);
		setPosition(null);
	};

	useEffect(() => () => clearTimeout(timerRef.current), []);

	// Escape and scrolling dismiss without moving focus (WCAG 1.4.13).
	useEffect(() => {
		if (!anchor) return;
		const dismiss = () => {
			setAnchor(null);
			setPosition(null);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") dismiss();
		};
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("scroll", dismiss, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", dismiss, true);
		};
	}, [anchor]);

	useLayoutEffect(() => {
		const bubble = bubbleRef.current;
		if (!anchor || !bubble) return;
		const a = anchor.getBoundingClientRect();
		const b = bubble.getBoundingClientRect();
		let left = a.left + a.width / 2 - b.width / 2;
		let top = a.top - b.height - GAP;
		if (side === "bottom" || (side === "top" && top < MARGIN)) top = a.bottom + GAP;
		if (side === "left" || side === "right") {
			top = a.top + a.height / 2 - b.height / 2;
			left = side === "left" ? a.left - b.width - GAP : a.right + GAP;
		}
		left = Math.min(Math.max(MARGIN, left), window.innerWidth - b.width - MARGIN);
		top = Math.min(Math.max(MARGIN, top), window.innerHeight - b.height - MARGIN);
		setPosition({ left, top });
	}, [anchor, side]);

	const props = children.props;
	const trigger = cloneElement(children, {
		"aria-describedby": describe && anchor ? id : props["aria-describedby"],
		onPointerEnter: (event: PointerEvent<HTMLElement>) => {
			props.onPointerEnter?.(event);
			const target = event.currentTarget;
			clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => setAnchor(target), SHOW_DELAY_MS);
		},
		onPointerLeave: (event: PointerEvent<HTMLElement>) => {
			props.onPointerLeave?.(event);
			hide();
		},
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			props.onPointerDown?.(event);
			hide();
		},
		onFocus: (event: FocusEvent<HTMLElement>) => {
			props.onFocus?.(event);
			if (event.currentTarget.matches(":focus-visible")) setAnchor(event.currentTarget);
		},
		onBlur: (event: FocusEvent<HTMLElement>) => {
			props.onBlur?.(event);
			hide();
		},
	});

	return (
		<>
			{trigger}
			{anchor &&
				createPortal(
					<div
						className="fixed z-(--sc-z-tooltip)"
						ref={bubbleRef}
						style={position ?? { left: 0, top: 0, visibility: "hidden" }}
					>
						<TooltipBubble content={content} id={id} shortcut={shortcut} />
					</div>,
					document.body,
				)}
		</>
	);
}
