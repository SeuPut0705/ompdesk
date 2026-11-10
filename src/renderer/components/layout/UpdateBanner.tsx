/**
 * Update failure notice above the session. Available, downloading and ready
 * updates live in the sidebar's update card (SidebarUpdateCard); only a
 * failure the user should act on (retry) shows here — as a calm, compact
 * notice (`Banner compact`, neutral), not an alarm: the app keeps working on the installed version.
 * `message` is localized by main; the raw cause (`detail`) stays in the
 * tooltip. The message is the useful part: it takes two lines before it
 * ellipsizes, and on a phone Check again is its glyph (the name stays its
 * label) so the message keeps the row.
 */
import { AlertCircle, RefreshCw } from "lucide-react";
import { useShellMode } from "../../hooks/use-shell-mode";
import { useT } from "../../lib/i18n";
import { checkForUpdatesInPlace, useUpdaterStore } from "../../stores/updater";
import { Banner, Button, IconButton, Tooltip } from "../common";

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
	return (
		<div className="shrink-0 px-(--omp-column-pad) pt-1 pb-0.5" data-update-notice>
			<Banner
				actions={
					phone ? (
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
					)
				}
				className="mx-auto max-w-(--omp-column-reading)"
				compact
				dismissLabel={t("updater.dismissFailure")}
				icon={<AlertCircle className="text-(--sc-warning)" />}
				onDismiss={dismissError}
				role="status"
				variant="neutral"
			>
				<Tooltip
					content={
						<>
							<span className="block">{status.message}</span>
							{status.detail && <span className="block">{status.detail}</span>}
						</>
					}
					describe={Boolean(status.detail)}
				>
					<span className="line-clamp-2">{status.message}</span>
				</Tooltip>
			</Banner>
		</div>
	);
}
