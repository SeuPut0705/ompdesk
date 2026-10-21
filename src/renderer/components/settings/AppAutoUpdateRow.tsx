import { Download } from "lucide-react";
/**
 * Settings › Updates & about › OMPdesk: "Install updates automatically" (pref `appAutoUpdate`, default on; only a
 * stored `false` turns it off). On, a downloaded update installs and restarts by itself (main `app-auto-update.ts`:
 * at the next safe point with Continue interrupted work on, else at a quiet moment); off, it waits for "Restart &
 * install" or an approved quit. A copy that cannot replace itself (read-only location, App Translocation: install
 * mode `manual`) shows the switch off and says why.
 */
import { useEffect, useState } from "react";
import { APP_AUTO_UPDATE_PREF } from "../../../shared/desktop-prefs";
import type { UpdateInstallMode } from "../../../shared/ipc-types";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

export function AppAutoUpdateRow() {
	const t = useT();
	const [enabled, setEnabled] = useMainPreference(APP_AUTO_UPDATE_PREF, true);
	const [mode, setMode] = useState<UpdateInstallMode>();
	useEffect(() => {
		let live = true;
		void window.omp.updater.installMode().then(next => {
			if (live) setMode(next);
		});
		return () => {
			live = false;
		};
	}, []);
	const unavailable = mode === "manual";
	return (
		<SettingsSwitchRow
			icon={<Download />}
			checked={enabled && !unavailable}
			description={unavailable ? t("updates.appAutoManual") : t("updates.appAutoDesc")}
			tipOnly={!unavailable}
			disabled={mode === undefined || unavailable}
			id="setting-gui-appAutoUpdate"
			label={t("updates.appAuto")}
			onCheckedChange={setEnabled}
		/>
	);
}
