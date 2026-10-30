/**
 * Toasts — brief, non-blocking feedback about something that just happened
 * ("Copied", "Session exported", a failed background request). They stack
 * top-right below the title bar, clear of the composer's send/stop
 * controls (at the work board's foot when one is docked at the right edge),
 * and auto-dismiss via a single pruning interval.
 *
 * Rules: title ≤ 4 words in the user's language, message one sentence,
 * never raw error text as the message — localize it and pass the raw cause
 * as `detail` (lib/error-detail), shown as a quiet, selectable second line.
 * Anything the user must act on to continue is a Banner or a Dialog; an
 * optional `action` only offers a shortcut to the fix (it dismisses the toast).
 * `ToastCard` is the visual, shared with the style guide.
 */

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { type ToastVariant, useToastStore } from "../../stores/toast";

const VARIANT_STYLES: Record<ToastVariant, { icon: string; Icon: typeof Info }> = {
	info: { icon: "text-(--sc-info)", Icon: Info },
	success: { icon: "text-(--sc-success)", Icon: CheckCircle2 },
	warning: { icon: "text-(--sc-warning)", Icon: AlertTriangle },
	error: { icon: "text-(--sc-danger)", Icon: XCircle },
};

export interface ToastCardProps {
	variant: ToastVariant;
	title?: ReactNode;
	message: ReactNode;
	/** Raw technical cause (error text) under the message: small, muted, selectable. */
	detail?: string;
	/** One follow-up, shown as a link-styled button under the message. */
	action?: { label: ReactNode; onClick: () => void };
	/** Repeat count; shown as ×N above 1. */
	count?: number;
	onDismiss?: () => void;
	className?: string;
}

/** A message's long paths break after a `/` or `\`, never mid-word ("compo / nents"); other text wraps as words. */
function withPathBreaks(text: string): ReactNode {
	const parts = text.split(/(?<=[/\\])(?=[^\s/\\])/);
	return parts.length === 1
		? text
		: parts.map((part, index) => (
				<Fragment key={index}>
					{index > 0 && <wbr />}
					{part}
				</Fragment>
			));
}

/** The detail only when it adds something: an error's raw text is often the message again behind "Error: ". */
function distinctDetail(detail: string | undefined, message: ReactNode): string | undefined {
	if (!detail || typeof message !== "string") return detail;
	return detail.replace(/^\s*[\w.]*Error:\s*/, "").trim() === message.trim() ? undefined : detail;
}

export function ToastCard({
	variant,
	title,
	message,
	detail: rawDetail,
	action,
	count = 1,
	onDismiss,
	className,
}: ToastCardProps) {
	const t = useT();
	const style = VARIANT_STYLES[variant];
	const Icon = style.Icon;
	const detail = distinctDetail(rawDetail, message);
	return (
		<div
			className={cx(
				"flex items-start gap-2.5 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) py-3 pr-2 pl-3 shadow-(--sc-shadow-md)",
				className,
			)}
			role={variant === "error" ? "alert" : "status"}
		>
			<Icon aria-hidden className={cx("mt-0.5 size-(--sc-icon-md) shrink-0", style.icon)} />
			<div className="min-w-0 flex-1 py-px">
				{title && (
					<div className="mb-0.5 text-sc-sm font-semibold break-words break-keep text-(--sc-text)">{title}</div>
				)}
				<div className="text-sc-sm break-words break-keep text-(--sc-text-secondary)">
					{typeof message === "string" ? withPathBreaks(message) : message}
				</div>
				{detail && (
					<div
						className="mt-1 line-clamp-3 font-mono text-sc-xs [overflow-wrap:anywhere] text-(--sc-text-subtle) select-text"
						data-toast-detail
						title={detail}
					>
						{withPathBreaks(detail)}
					</div>
				)}
				{action && (
					<button
						className="mt-1.5 text-sc-sm font-medium text-(--sc-accent) hover:underline"
						data-toast-action
						onClick={action.onClick}
						type="button"
					>
						{action.label}
					</button>
				)}
			</div>
			{count > 1 && (
				<span
					className="mt-0.5 shrink-0 rounded-(--sc-radius-full) bg-(--sc-surface-3) px-1.5 text-sc-2xs font-semibold tabular-nums text-(--sc-text-muted)"
					title={t("toast.repeated", { count })}
				>
					×{count}
				</span>
			)}
			{onDismiss && (
				<button
					aria-label={t("common.close")}
					className="-my-1 inline-flex size-(--sc-hit-min) shrink-0 items-center justify-center rounded-(--sc-radius-sm) text-(--sc-text-subtle) hover:bg-(--sc-hover) hover:text-(--sc-text)"
					onClick={onDismiss}
					type="button"
				>
					<X aria-hidden className="size-(--sc-icon-sm)" />
				</button>
			)}
		</div>
	);
}

export function ToastStack() {
	const toasts = useToastStore(state => state.toasts);
	const dismiss = useToastStore(state => state.dismiss);
	const pruneExpired = useToastStore(state => state.pruneExpired);
	const hold = useToastStore(state => state.hold);
	// A toast being read never expires under the pointer or keyboard focus.
	const [pointerOver, setPointerOver] = useState(false);
	const [focusWithin, setFocusWithin] = useState(false);
	const count = useRef(toasts.length);

	useEffect(() => {
		// A toast removed under the pointer fires no mouseleave: drop the hover
		// whenever one goes, so a stale hover never holds the rest forever.
		if (toasts.length < count.current) setPointerOver(false);
		if (toasts.length === 0) setFocusWithin(false);
		count.current = toasts.length;
	}, [toasts.length]);

	useEffect(() => hold(pointerOver || focusWithin), [hold, pointerOver, focusWithin]);
	useEffect(() => () => hold(false), [hold]);

	useEffect(() => {
		if (toasts.length === 0) return;
		const timer = setInterval(pruneExpired, 500);
		return () => clearInterval(timer);
	}, [toasts.length, pruneExpired]);

	// A work board docked along the window's right edge holds what needs the person at its top ("Needs you"); toasts
	// there covered it (and its rows under them). With one on screen they gather at its foot instead, which is clear of
	// the composer's Send and Stop (those sit in the transcript's column, left of the board).
	const [atFoot, setAtFoot] = useState(false);
	const shown = toasts.length > 0;
	// Measured again as each toast arrives: a board that docked after the first one (its first child started) counts.
	useLayoutEffect(() => {
		if (toasts.length === 0) return;
		const measure = () => {
			if (document.documentElement.dataset.shell === "phone") return setAtFoot(false);
			const right = window.innerWidth;
			setAtFoot(
				Array.from(document.querySelectorAll("[data-work-board-panel]")).some(panel => {
					const box = panel.getBoundingClientRect();
					return box.width > 0 && box.right >= right - 32 && box.top < 160;
				}),
			);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [toasts.length]);

	if (!shown) return null;

	return createPortal(
		<div
			aria-live="polite"
			className={cx(
				"omp-toast-stack pointer-events-none fixed right-4 z-(--sc-z-toast) flex w-80 max-w-[calc(100vw-2rem)] flex-col [--omp-toast-top:7rem]",
				atFoot ? "bottom-[calc(1rem+var(--safe-b,0px))]" : "top-(--omp-toast-top)",
			)}
			data-toast-at={atFoot ? "board-foot" : undefined}
			data-toast-stack
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
			}}
			onFocus={() => setFocusWithin(true)}
			onMouseEnter={() => setPointerOver(true)}
			onMouseLeave={() => setPointerOver(false)}
		>
			{/* More toasts than the window holds scroll here instead of running past its bottom edge. The 1 rem of
			    padding around them (taken back by the margin) keeps their shadows out of the scroller's clip. */}
			<div
				className="omp-toast-scroll -m-4 flex max-h-[calc(100dvh_-_var(--omp-toast-top)_+_1rem_-_var(--safe-b,0px))] flex-col gap-2 overflow-y-auto overscroll-contain p-4 [scrollbar-width:thin]"
				data-toast-scroll
			>
				{toasts.map(entry => (
					<ToastCard
						action={
							entry.action
								? {
										label: entry.action.label,
										onClick: () => {
											dismiss(entry.id);
											entry.action?.run();
										},
									}
								: undefined
						}
						className={
							entry.exitingAt != null ? "pointer-events-none omp-toast-out" : "pointer-events-auto omp-toast-in"
						}
						count={entry.count}
						detail={entry.detail}
						key={entry.id}
						message={entry.message}
						onDismiss={() => dismiss(entry.id)}
						title={entry.title}
						variant={entry.variant}
					/>
				))}
			</div>
		</div>,
		document.body,
	);
}
