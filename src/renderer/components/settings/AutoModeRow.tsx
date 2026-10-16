/**
 * Settings › Agent behavior › Smart automation: choose Plan or Goal mode for a prompt (pref `autoMode`, default on).
 * A small model decides in at most 1.5 s when a prompt is sent with no mode active; Loop, Vibe and the other modes
 * stay manual. The Mode popover in the composer holds the same switch.
 */

import { Wand2 } from "lucide-react";
import { AUTO_MODE_PREF } from "../../../../resources/gui-bridge/auto-mode-contracts";
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
