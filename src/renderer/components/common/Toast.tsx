/**
 * Toasts — brief, non-blocking feedback about something that just happened
 * ("Copied", "Session exported", a failed background request). They stack
 * top-right below the title bar, clear of the composer's send/stop
 * controls, and auto-dismiss via a single pruning interval.
 *
 * Rules: title ≤ 4 words in the user's language, message one sentence,
 * never raw error text as the message — localize it and pass the raw cause
 * as `detail` (lib/error-detail), shown as a quiet, selectable second line.
 * Anything the user must act on to continue is a Banner or a Dialog; an
 * optional `action` only offers a shortcut to the fix (it dismisses the toast).
 * `ToastCard` is the visual, shared with the style guide.
 */

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
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

export function ToastCard({
	variant,
	title,
	message,
	detail,
	action,
	count = 1,
	onDismiss,
	className,
}: ToastCardProps) {
	const t = useT();
	const style = VARIANT_STYLES[variant];
	const Icon = style.Icon;
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
				{title && <div className="mb-0.5 text-sc-sm font-semibold break-words text-(--sc-text)">{title}</div>}
				<div className="text-sc-sm break-words break-keep text-(--sc-text-secondary)">{message}</div>
				{detail && (
					<div
						className="mt-1 line-clamp-3 font-mono text-sc-xs [overflow-wrap:anywhere] text-(--sc-text-subtle) select-text"
						data-toast-detail
						title={detail}
					>
						{detail}
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

	if (toasts.length === 0) return null;

	return createPortal(
		<div
			aria-live="polite"
			className="pointer-events-none fixed top-28 right-4 z-(--sc-z-toast) flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
			}}
			onFocus={() => setFocusWithin(true)}
			onMouseEnter={() => setPointerOver(true)}
			onMouseLeave={() => setPointerOver(false)}
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
		</div>,
		document.body,
	);
}
