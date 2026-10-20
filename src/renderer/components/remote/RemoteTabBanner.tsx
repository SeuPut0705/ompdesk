/**
 * Offline state of a remote tab: once the link to its host has stayed down for `LINK_NOTICE_GRACE_MS` the
 * tab says it is reconnecting (the host keeps the session alive and main resumes the tab when the link
 * returns); a blip, an app start and the time before the device list loads say nothing. A host that was
 * removed says so at once and points at Settings › Devices & connections. Local tabs and online hosts
 * render nothing.
 */
import { useT } from "../../lib/i18n";
import { useHostLinkLost, useRemoteStore } from "../../stores/remote";
import { useUiStore } from "../../stores/ui";
import { Banner, Button } from "../common";

export function RemoteTabBanner({ deviceId }: { deviceId: string }) {
	const t = useT();
	const loaded = useRemoteStore(store => store.state !== null);
	const host = useRemoteStore(store => store.state?.hosts.find(entry => entry.deviceId === deviceId));
	const lost = useHostLinkLost(deviceId);
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
	if (!host || !lost) return null;
	return (
		<div data-remote-reconnecting={deviceId}>
			<Banner className="mx-3 mt-2" live title={t("remote.tab.reconnecting", { name: host.name })} variant="warning">
				{t("remote.tab.reconnectingDesc")}
			</Banner>
		</div>
	);
}
