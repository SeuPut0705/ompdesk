/**
 * Toasts sit below the top navigation, clear of composer send/stop controls.
 * Auto-dismisses via a single pruning interval; slide-in per toast.
 */

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { type ToastVariant, useToastStore } from "../../stores/toast";

const VARIANT_STYLES: Record<ToastVariant, { border: string; icon: string; Icon: typeof Info }> = {
	info: { border: "border-l-(--omp-link)", icon: "text-(--omp-link)", Icon: Info },
	success: { border: "border-l-(--omp-success)", icon: "text-(--omp-success)", Icon: CheckCircle2 },
	warning: { border: "border-l-(--omp-warning)", icon: "text-(--omp-warning)", Icon: AlertTriangle },
	error: { border: "border-l-(--omp-error)", icon: "text-(--omp-error)", Icon: XCircle },
};

export function ToastStack() {
	const t = useT();
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
		<div aria-live="polite" className="pointer-events-none fixed top-28 right-4 z-[70] flex w-80 flex-col gap-2">
			{toasts.map(entry => {
				const style = VARIANT_STYLES[entry.variant];
				const Icon = style.Icon;
				return (
					<div
						className={`flex items-start gap-2.5 rounded-xl border border-(--omp-border-muted) border-l-2 bg-(--omp-toast-bg) px-3 py-2.5 shadow-(--omp-shadow-lg) ${style.border} ${entry.exitingAt != null ? "pointer-events-none omp-toast-out" : "pointer-events-auto omp-toast-in"}`}
						key={entry.id}
						role={entry.variant === "error" ? "alert" : "status"}
					>
						<Icon className={`mt-px shrink-0 ${style.icon}`} size={14} />
						<div className="min-w-0 flex-1">
							{entry.title && (
								<div className="mb-0.5 text-omp-sm font-semibold text-(--omp-text)">{entry.title}</div>
							)}
							<div className="text-omp-sm leading-snug break-words text-(--omp-muted)">{entry.message}</div>
						</div>
						{entry.count > 1 && (
							<span
								className="shrink-0 rounded-full border border-(--omp-border-muted) px-1.5 py-0.5 text-omp-xs font-semibold tabular-nums text-(--omp-muted)"
								title={t("toast.repeated", { count: entry.count })}
							>
								×{entry.count}
							</span>
						)}
						<button
							aria-label={t("common.close")}
							className="shrink-0 rounded p-0.5 text-(--omp-dim) transition-colors hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
							onClick={() => dismiss(entry.id)}
							type="button"
						>
							<X size={12} />
						</button>
					</div>
				);
			})}
		</div>,
		document.body,
	);
}
