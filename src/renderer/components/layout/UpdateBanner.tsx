/**
 * Update failure banner above the session. Available, downloading and ready
 * updates live in the sidebar's update card (SidebarUpdateCard); only a
 * failure the user should act on (retry) shows here.
 */
import { AlertTriangle, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useUpdaterStore } from "../../stores/updater";
import { Button } from "../common";

export function UpdateBanner() {
	const t = useT();
	const status = useUpdaterStore(s => s.status);
	const dismissed = useUpdaterStore(s => s.dismissed);
	const dismissError = useUpdaterStore(s => s.dismissError);

	// A dismissed failure stays hidden until a check actually succeeds again, so
	// the four-hourly poll can't resurrect a banner the user already closed.
	if (status.state !== "error" || status.showInBanner === false || dismissed.error) return null;
	return (
		<div className="flex items-center gap-2 border-b border-(--omp-border-muted) bg-transparent px-3 py-1.5 text-omp-md">
			<AlertTriangle size={13} className="shrink-0 text-(--omp-error)" />
			<span className="min-w-0 flex-1 text-(--omp-error)">{status.message}</span>
			<Button size="sm" onClick={() => void window.omp.updater.check()}>
				{t("updater.retry")}
			</Button>
			<button
				type="button"
				aria-label={t("updater.dismissFailure")}
				className="shrink-0 text-(--omp-dim) hover:text-(--omp-text)"
				onClick={dismissError}
			>
				<X size={13} />
			</button>
		</div>
	);
}
