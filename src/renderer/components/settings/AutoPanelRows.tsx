/**
 * Settings › Agent behavior › Smart automation: the switch for a dev server's address in a bash
 * result opening the Preview by itself (`lib/panel-auto-open.ts`, pref `autoPreviewDevServer`,
 * default on, read when the event happens).
 */

import { MonitorPlay } from "lucide-react";
import { AUTO_PREVIEW_DEV_SERVER_PREF } from "../../../shared/desktop-prefs";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

export function AutoPreviewRow() {
	const t = useT();
	const [on, setOn] = useMainPreference(AUTO_PREVIEW_DEV_SERVER_PREF, true);
	return (
		<SettingsSwitchRow
			checked={on}
			description={t("settings.gui.autoPreviewDevServerDesc")}
			icon={<MonitorPlay />}
			id="setting-gui-autoPreviewDevServer"
			label={t("settings.gui.autoPreviewDevServer")}
			onCheckedChange={setOn}
		/>
	);
}
