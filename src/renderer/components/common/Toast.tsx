/**
 * Toasts — brief, non-blocking feedback about something that just happened
 * ("Copied", "Session exported", a failed background request). They stack
 * top-right below the title bar, clear of the composer's send/stop
 * controls, and auto-dismiss via a single pruning interval.
 *
 * Rules: title ≤ 4 words in the user's language, message one sentence,
 * never raw error text from the agent alone — map it (lib/runtime-errors).
 * Anything the user must act on to continue is a Banner or a Dialog.
 * `ToastCard` is the visual, shared with the style guide.
 */

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { type ReactNode, useEffect } from "react";
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
	/** Repeat count; shown as ×N above 1. */
	count?: number;
	onDismiss?: () => void;
	className?: string;
}

export function ToastCard({ variant, title, message, count = 1, onDismiss, className }: ToastCardProps) {
	const t = useT();
	const style = VARIANT_STYLES[variant];
	const Icon = style.Icon;
	return (
		<div
			className={cx(
				"flex items-start gap-2.5 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) py-2.5 pr-2 pl-3 shadow-(--sc-shadow-lg)",
				className,
			)}
			role={variant === "error" ? "alert" : "status"}
		>
			<Icon aria-hidden className={cx("mt-0.5 shrink-0", style.icon)} size={16} />
			<div className="min-w-0 flex-1 py-px">
				{title && <div className="mb-0.5 text-sc-sm font-semibold text-(--sc-text)">{title}</div>}
				<div className="text-sc-sm break-words text-(--sc-text-secondary)">{message}</div>
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
					<X size={14} />
				</button>
			)}
		</div>
	);
}

export function ToastStack() {
	const toasts = useToastStore(state => state.toasts);
	const dismiss = useToastStore(state => state.dismiss);
	const pruneExpired = useToastStore(state => state.pruneExpired);

	useEffect(() => {
		if (toasts.length === 0) return;
		const timer = setInterval(pruneExpired, 500);
		return () => clearInterval(timer);
	}, [toasts.length, pruneExpired]);

	if (toasts.length === 0) return null;

	return createPortal(
		<div
			aria-live="polite"
			className="pointer-events-none fixed top-28 right-4 z-(--sc-z-toast) flex w-80 flex-col gap-2"
		>
			{toasts.map(entry => (
				<ToastCard
					className={
						entry.exitingAt != null ? "pointer-events-none omp-toast-out" : "pointer-events-auto omp-toast-in"
					}
					count={entry.count}
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
