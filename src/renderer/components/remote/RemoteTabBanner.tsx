/**
 * Offline state of a remote tab: while the link to its host is down the tab
 * says it is reconnecting (the host keeps the session alive and main resumes
 * the tab when the link returns); a host that was removed says so and points
 * at Settings › Remote devices. Local tabs and online hosts render nothing.
 */
import { useT } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useUiStore } from "../../stores/ui";
import { Banner, Button } from "../common";

export function RemoteTabBanner({ deviceId }: { deviceId: string }) {
	const t = useT();
	const loaded = useRemoteStore(store => store.state !== null);
	const host = useRemoteStore(store => store.state?.hosts.find(entry => entry.deviceId === deviceId));
	if (host?.state === "online") return null;
	if (loaded && !host) {
		return (
			<Banner
				actions={
					<Button
						onClick={() => useUiStore.getState().openSettings("connections:remote")}
						size="sm"
						variant="secondary"
					>
						{t("remote.openSettings")}
					</Button>
				}
				className="mx-3 mt-2"
				live
				title={t("remote.tab.removed")}
				variant="danger"
			>
				{t("remote.tab.removedDesc")}
			</Banner>
		);
	}
	const name = host?.name ?? t("remote.tab.unknownDevice");
	return (
		<div data-remote-reconnecting={deviceId}>
			<Banner className="mx-3 mt-2" live title={t("remote.tab.reconnecting", { name })} variant="warning">
				{t("remote.tab.reconnectingDesc")}
			</Banner>
		</div>
	);
}
