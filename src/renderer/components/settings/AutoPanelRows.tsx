/**
 * Settings › Agent behavior › Smart automation: the two switches for the side panel opening by
 * itself (`lib/panel-auto-open.ts`). `autoPreviewDevServer`: a dev server's address in a bash
 * result opens the Preview; `autoOpenChanges`: a turn that edited files opens Changes at its end
 * while the panel is closed. Both default on and are read when the event happens.
 */

import { FileDiff, MonitorPlay } from "lucide-react";
import { AUTO_OPEN_CHANGES_PREF, AUTO_PREVIEW_DEV_SERVER_PREF } from "../../../shared/desktop-prefs";
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

export function AutoChangesRow() {
	const t = useT();
	const [on, setOn] = useMainPreference(AUTO_OPEN_CHANGES_PREF, true);
	return (
		<SettingsSwitchRow
			checked={on}
			description={t("settings.gui.autoOpenChangesDesc")}
			icon={<FileDiff />}
			id="setting-gui-autoOpenChanges"
			label={t("settings.gui.autoOpenChanges")}
			onCheckedChange={setOn}
		/>
	);
}
