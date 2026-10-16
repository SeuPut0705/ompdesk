/**
 * Settings › Agent behavior › Smart automation: fold several tabs finishing, failing or
 * asking within seconds into one desktop notification (pref `batchNotifications`, default
 * on). Main reads it per notification (`SYSTEM_NOTIFY`), so a change applies at once.
 */

import { BellRing } from "lucide-react";
import { BATCH_NOTIFICATIONS_PREF } from "../../../shared/desktop-prefs";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

export function BatchNotificationsRow() {
	const t = useT();
	const [batch, setBatch] = useMainPreference(BATCH_NOTIFICATIONS_PREF, true);
	return (
		<SettingsSwitchRow
			checked={batch}
			description={t("settings.gui.batchNotificationsDesc")}
			icon={<BellRing />}
			id="setting-gui-batchNotifications"
			label={t("settings.gui.batchNotifications")}
			onCheckedChange={setBatch}
		/>
	);
}
