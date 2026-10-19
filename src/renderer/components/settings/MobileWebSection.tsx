/**
 * Settings › Devices & connections › Mobile web: OMPdesk's own page on this computer, published to the
 * user's tailnet with `tailscale serve`, so a phone or tablet signed in to the same Tailscale account runs OMPdesk
 * in its browser — no code, no QR to scan, the first visit connects it.
 *
 * The switch turns it on; main walks the Tailscale steps (install, start, approve, sign in, HTTPS) and
 * the phase panel under the switch shows the current one with its single next action. When it is ready the
 * link (a big Copy button and one QR) and the phone-side steps appear, then the connected devices (Block), the
 * blocked ones (Unblock) and the allowed Tailscale users. "Approve new devices on this computer" brings back a
 * confirm step. Main owns the state (`window.omp.mobileWeb`, stores/mobile-web.ts); this page tells main it is
 * open (`watch`) so Tailscale is polled every 2 s meanwhile.
 */
import { RefreshCw, ShieldCheck, Smartphone } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { loadMobileWeb, mobileWebCommand, useMobileWebStore, useMobileWebSync } from "../../stores/mobile-web";
import { webPwa } from "../../web/pwa";
import { Banner, Button, ErrorDetail, Spinner } from "../common";
import { MobileWebConnect } from "./MobileWebConnect";
import { MobileWebAllowedUsers, MobileWebBlocked, MobileWebDevices } from "./MobileWebDevices";
import { MobileWebPhasePanel } from "./MobileWebPhase";
import { SettingsSection, SettingsSwitchRow } from "./SettingsLayout";
import { WebNotificationsSection } from "./WebNotificationsSection";

/**
 * On the computer: the whole section. On the web page (a paired device): only this device's own notification
 * and install controls — pairing, Tailscale and the device list are the computer's (`pairing-admin`).
 */
export function MobileWebSection() {
	const pwa = webPwa();
	return pwa ? <WebNotificationsSection pwa={pwa} /> : <MobileWebHostSection />;
}

function MobileWebHostSection() {
	const t = useT();
	useMobileWebSync();
	const state = useMobileWebStore(store => store.state);
	const devices = useMobileWebStore(store => store.devices);
	const blocked = useMobileWebStore(store => store.blocked);
	const loadError = useMobileWebStore(store => store.loadError);
	const [toggling, setToggling] = useState(false);

	if (!state) {
		return loadError ? (
			<Banner
				actions={
					<Button icon={<RefreshCw />} onClick={() => void loadMobileWeb()} size="sm" variant="secondary">
						{t("common.retry")}
					</Button>
				}
				live
				title={t("mobileWeb.loadFailed")}
				variant="danger"
			>
				<ErrorDetail error={loadError} />
			</Banner>
		) : (
			<div className="flex justify-center py-8">
				<Spinner />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-8" data-mobile-web-section data-mobile-web-state={state.phase}>
			<SettingsSection>
				<SettingsSwitchRow
					icon={<Smartphone />}
					checked={state.enabled}
					description={t("mobileWeb.toggleDesc")}
					tipOnly
					disabled={toggling}
					footer={<MobileWebPhasePanel state={state} />}
					id="settings-mobile-web-toggle"
					label={t("mobileWeb.toggle")}
					onCheckedChange={enabled => {
						setToggling(true);
						void mobileWebCommand(
							{ action: enabled ? "enable" : "disable" },
							t("mobileWeb.toggleFailed"),
						).finally(() => setToggling(false));
					}}
				/>
				{state.enabled && (
					<SettingsSwitchRow
						icon={<ShieldCheck />}
						checked={state.confirmNewDevices}
						description={t("mobileWeb.confirmNewDesc")}
						tipOnly
						id="settings-mobile-web-confirm"
						label={t("mobileWeb.confirmNew")}
						onCheckedChange={on =>
							void mobileWebCommand({ action: "set-confirm-new-devices", on }, t("mobileWeb.toggleFailed"))
						}
					/>
				)}
			</SettingsSection>
			{state.enabled && state.phase === "ready" && state.url && <MobileWebConnect state={state} url={state.url} />}
			{(state.enabled || (devices?.length ?? 0) > 0) && <MobileWebDevices devices={devices ?? []} />}
			{(blocked?.length ?? 0) > 0 && <MobileWebBlocked blocked={blocked ?? []} />}
			{state.enabled && <MobileWebAllowedUsers state={state} />}
		</div>
	);
}
