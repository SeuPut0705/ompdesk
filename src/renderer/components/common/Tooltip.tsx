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
	type MouseEvent,
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
import { useShellInput } from "../../hooks/use-shell-mode";
import { cx } from "../../lib/format";
import { formatShortcut } from "../../lib/keymap";

export type TooltipSide = "top" | "bottom" | "left" | "right";

const SHOW_DELAY_MS = 450;
/** A finger: how long a press must hold to open the bubble, and how long the bubble then stays. */
const TOUCH_PRESS_MS = 500;
const TOUCH_LINGER_MS = 4000;
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
				"pointer-events-none w-max max-w-[min(18rem,calc(100vw-1rem))] rounded-(--sc-radius-sm) bg-(--sc-text) px-2 py-1 text-sc-xs font-medium break-words text-(--sc-bg) shadow-(--sc-shadow-md)",
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
	const pressRef = useRef<number | undefined>(undefined);
	/** The press that opened the bubble: the click it leads to is swallowed. */
	const pressedRef = useRef(false);
	const touch = useShellInput() === "touch";

	const hide = () => {
		clearTimeout(timerRef.current);
		setAnchor(null);
		setPosition(null);
	};

	useEffect(() => () => clearTimeout(timerRef.current), []);
	useEffect(() => () => clearTimeout(pressRef.current), []);

	// A bubble a finger opened has no pointer to leave: it goes with the next press elsewhere, or by itself.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `hide` only clears state setters and a ref'd timer.
	useEffect(() => {
		if (!anchor || !touch) return;
		const elsewhere = (event: globalThis.PointerEvent) => {
			if (!anchor.contains(event.target as globalThis.Node | null)) hide();
		};
		const timer = window.setTimeout(hide, TOUCH_LINGER_MS);
		document.addEventListener("pointerdown", elsewhere, true);
		return () => {
			window.clearTimeout(timer);
			document.removeEventListener("pointerdown", elsewhere, true);
		};
	}, [anchor, touch]);

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
	// Where the main pointer is a finger there is no hover: a long press (or, for a control that does nothing
	// on tap — an info glyph — a tap) opens the bubble, and the press that opened it never also clicks.
	const tapOpens = touch && props.onClick === undefined;
	const fingerDown = (event: PointerEvent<HTMLElement>) => touch && event.pointerType === "touch";
	const stopPress = () => clearTimeout(pressRef.current);
	const trigger = cloneElement(children, {
		"aria-describedby": describe && anchor ? id : props["aria-describedby"],
		onPointerEnter: (event: PointerEvent<HTMLElement>) => {
			props.onPointerEnter?.(event);
			if (fingerDown(event)) return;
			const target = event.currentTarget;
			clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => setAnchor(target), SHOW_DELAY_MS);
		},
		onPointerLeave: (event: PointerEvent<HTMLElement>) => {
			props.onPointerLeave?.(event);
			if (fingerDown(event)) return stopPress();
			hide();
		},
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			props.onPointerDown?.(event);
			if (fingerDown(event)) {
				const target = event.currentTarget;
				stopPress();
				pressedRef.current = false;
				if (!tapOpens) {
					pressRef.current = window.setTimeout(() => {
						pressedRef.current = true;
						setAnchor(target);
					}, TOUCH_PRESS_MS);
				}
				return;
			}
			hide();
		},
		onPointerUp: (event: PointerEvent<HTMLElement>) => {
			props.onPointerUp?.(event);
			stopPress();
		},
		onPointerCancel: (event: PointerEvent<HTMLElement>) => {
			props.onPointerCancel?.(event);
			stopPress();
		},
		onClickCapture: (event: MouseEvent<HTMLElement>) => {
			props.onClickCapture?.(event);
			if (!pressedRef.current) return;
			pressedRef.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
		...(tapOpens
			? {
					onClick: (event: MouseEvent<HTMLElement>) => {
						const target = event.currentTarget;
						setAnchor(current => (current === target ? null : target));
					},
				}
			: {}),
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
