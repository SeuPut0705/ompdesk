/**
 * Update failure notice above the session. Available, downloading and ready
 * updates live in the sidebar's update card (SidebarUpdateCard); only a
 * failure the user should act on (retry) shows here — as a calm, compact
 * notice, not an alarm: the app keeps working on the installed version.
 * `message` is localized by main; the raw cause (`detail`) stays in the
 * tooltip. The message is the useful part: it takes two lines before it
 * ellipsizes, and on a phone Check again is its glyph (the name stays its
 * label) so the message keeps the row.
 */
import { AlertCircle, RefreshCw, X } from "lucide-react";
import { useShellMode } from "../../hooks/use-shell-mode";
import { useT } from "../../lib/i18n";
import { checkForUpdatesInPlace, useUpdaterStore } from "../../stores/updater";
import { Button, IconButton } from "../common";

export function UpdateBanner() {
	const t = useT();
	const status = useUpdaterStore(s => s.status);
	const dismissed = useUpdaterStore(s => s.dismissed);
	const dismissError = useUpdaterStore(s => s.dismissError);
	// A check the user just asked for reports its own failure in the sidebar card.
	const manualCheck = useUpdaterStore(s => s.manualCheck);
	const phone = useShellMode() === "phone";
	// A dismissed failure stays hidden until a check actually succeeds again, so
	// the four-hourly poll can't resurrect a banner the user already closed.
	if (manualCheck || status.state !== "error" || status.showInBanner === false || dismissed.error) return null;
	const tooltip = status.detail ? `${status.message}\n${status.detail}` : status.message;
	return (
		<div className="shrink-0 px-(--omp-column-pad) pt-2 pb-1" data-update-notice role="status">
			<div className="mx-auto flex max-w-(--omp-column-reading) items-center gap-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-2) py-1 pr-1 pl-2.5 text-sc-sm">
				<AlertCircle aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-warning)" />
				<span className="line-clamp-2 min-w-0 flex-1 text-(--sc-text-secondary)" title={tooltip}>
					{status.message}
				</span>
				{phone ? (
					<IconButton
						icon={<RefreshCw />}
						label={t("updater.retry")}
						onClick={() => void checkForUpdatesInPlace()}
						size="sm"
					/>
				) : (
					<Button icon={<RefreshCw />} onClick={() => void checkForUpdatesInPlace()} size="sm" variant="ghost">
						{t("updater.retry")}
					</Button>
				)}
				<IconButton icon={<X />} label={t("updater.dismissFailure")} onClick={dismissError} size="sm" />
			</div>
		</div>
	);
}
