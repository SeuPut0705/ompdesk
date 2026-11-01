/**
 * A remote tab whose host was removed says so at once and points at Settings › Devices & connections. A link that is
 * down is not drawn here: the title bar's status turns to "Reconnecting to {name}…" once it has stayed down for
 * `LINK_NOTICE_GRACE_MS` (the host keeps the session alive and main resumes the tab when the link returns). Local
 * tabs and hosts that are still paired render nothing.
 */
import { useT } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useUiStore } from "../../stores/ui";
import { Banner, Button } from "../common";

export function RemoteTabBanner({ deviceId }: { deviceId: string }) {
	const t = useT();
	const loaded = useRemoteStore(store => store.state !== null);
	const known = useRemoteStore(store => store.state?.hosts.some(entry => entry.deviceId === deviceId) === true);
	if (!loaded || known) return null;
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
