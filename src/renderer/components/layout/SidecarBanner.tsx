/**
 * Per-session sidecar status banner. Shows when the agent process is not usable:
 * failed, exited, crash-looping through its restart attempts, or "ready" but
 * failing health checks. Restart attempts are amber progress reporting; the
 * rest is an error with a restart action.
 */

import { RefreshCw } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useHostView } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { Banner, Button } from "../common";

export function SidecarBanner() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const status = useSessionStore(s => s.status);
	const cwd = useSessionStore(s => s.cwd);
	const sidecarError = useSessionStore(s => s.sidecarError);
	const sidecarRestart = useSessionStore(s => s.sidecarRestart);
	// Another omp still holds the session: the tab opens it by itself, so this is a wait, not a failure.
	const held = useSessionStore(s => s.sidecarHeld);
	const sidecarDismissed = useSessionStore(s => s.sidecarDismissed);
	const clearSidecarError = useSessionStore(s => s.clearSidecarError);
	const dismissSidecarBanner = useSessionStore(s => s.dismissSidecarBanner);
	const device = useTabsStore(s => s.tabs.find(tab => tab.id === tabId)?.device);
	const host = useHostView(device);

	const local = device === undefined;
	const restarting = status === "restarting";
	// Show banner when the sidecar is down, respawning itself, or a health check
	// failed on a nominally "ready" process.
	const show = restarting || status === "error" || status === "exited" || sidecarError !== null;

	// A remote tab whose link is down is reconnecting, not broken: its pane's
	// RemoteTabBanner says so, and a restart here could not reach the host.
	if (!local && host?.state !== "online") return null;
	if (!show || sidecarDismissed) return null;

	const progress =
		sidecarRestart === null
			? null
			: restarting
				? t("sidecar.attempt", { attempt: sidecarRestart.attempt, maxAttempts: sidecarRestart.maxAttempts })
				: status === "error"
					? t("sidecar.exhausted", { maxAttempts: sidecarRestart.maxAttempts })
					: null;
	const reason =
		sidecarError ??
		(status === "error"
			? t("sidecar.failedStart")
			: status === "exited"
				? t("sidecar.exited")
				: restarting
					? t("sidecar.restartingTitle")
					: t("sidecar.notResponding"));

	return (
		<Banner
			live
			variant={restarting || held ? "warning" : "danger"}
			className="rounded-none border-x-0 border-t-0 px-4"
			title={held ? t("sidecar.heldTitle") : restarting ? t("sidecar.restartingTitle") : t("sidecar.title")}
			onDismiss={dismissSidecarBanner}
			actions={
				<Button
					icon={<RefreshCw />}
					onClick={() => {
						clearSidecarError();
						void window.omp.sidecar
							.restart(tabId ? { tabId } : undefined)
							.catch((error: unknown) => toastError({ title: t("settings.connection.restartFailed"), error }));
					}}
					size="sm"
					variant="secondary"
				>
					{t("sidecar.restart")}
				</Button>
			}
		>
			<p className="text-sc-sm break-words" title={reason}>
				{progress ? `${progress} — ${reason}` : reason}
			</p>
			{cwd && <p className="mt-0.5 text-sc-xs break-all text-(--sc-text-muted)">{t("sidecar.project", { cwd })}</p>}
		</Banner>
	);
}
