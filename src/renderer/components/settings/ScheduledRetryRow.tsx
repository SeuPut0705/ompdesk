/**
 * Settings › Agent behavior › Smart automation: retry a turn that ended in a temporary error
 * (server trouble, overload, a dropped connection) after stock's own retries gave up: 30 s, 2 min,
 * 10 min, three tries (pref `scheduledRetry`, default on). Main's turn-resume reads it when a
 * turn fails and again when a retry is due, so a change applies at once.
 */

import { TimerReset } from "lucide-react";
import { SCHEDULED_RETRY_PREF } from "../../../shared/desktop-prefs";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

export function ScheduledRetryRow() {
	const t = useT();
	const [retry, setRetry] = useMainPreference(SCHEDULED_RETRY_PREF, true);
	return (
		<SettingsSwitchRow
			checked={retry}
			description={t("settings.gui.scheduledRetryDesc")}
			icon={<TimerReset />}
			id="setting-gui-scheduledRetry"
			label={t("settings.gui.scheduledRetry")}
			onCheckedChange={setRetry}
		/>
	);
}
