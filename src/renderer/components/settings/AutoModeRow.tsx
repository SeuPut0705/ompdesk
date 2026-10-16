/**
 * Settings › Agent behavior › Smart automation: use Plan or Goal for one new request (pref `autoMode`, default on).
 * A small model decides in at most 2 s when a prompt that starts new work is sent with no mode on; it never changes
 * the user's mode, and the other modes stay manual. The Mode popover in the composer holds the same
 * switch.
 */

import { Wand2 } from "lucide-react";
import { AUTO_MODE_PREF } from "../../../../resources/gui-bridge/modes/auto-mode-contracts";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

export function AutoModeRow() {
	const t = useT();
	const [enabled, setEnabled] = useMainPreference(AUTO_MODE_PREF, true);
	return (
		<SettingsSwitchRow
			checked={enabled}
			description={t("settings.gui.autoModeDesc")}
			icon={<Wand2 />}
			id="setting-gui-autoMode"
			label={t("settings.gui.autoMode")}
			onCheckedChange={setEnabled}
		/>
	);
}
