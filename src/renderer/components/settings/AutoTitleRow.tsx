/**
 * Settings › Agent behavior › Session titles: automatic titles (prefs `autoTitle`) and their sub-switch for keeping
 * the title current as the work changes (`autoTitleEvolve`, only effective under the first). Stock names a
 * session only in its terminal UI; the bridge runs stock's own title machinery for GUI tabs
 * (resources/gui-bridge/modes/auto-title.ts). Main pushes a change to every live local session; a paired host's tab
 * follows the host's pref. A title the user typed never changes whatever these say.
 */
import { RefreshCw, Sparkles } from "lucide-react";
import { AUTO_TITLE_EVOLVE_PREF, AUTO_TITLE_PREF } from "../../../../resources/gui-bridge/modes/auto-title-contracts";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

export function AutoTitleRow() {
	const t = useT();
	const [enabled, setEnabled] = useMainPreference(AUTO_TITLE_PREF, true);
	const [evolve, setEvolve] = useMainPreference(AUTO_TITLE_EVOLVE_PREF, true);
	return (
		<>
			<SettingsSwitchRow
				checked={enabled}
				description={`${t("settings.gui.autoTitleDesc")} ${t("settings.gui.autoTitleCost")}`}
				icon={<Sparkles />}
				id="setting-gui-autoTitle"
				label={t("settings.gui.autoTitle")}
				onCheckedChange={setEnabled}
			/>
			<div className="pl-4" data-auto-title-evolve="true">
				<SettingsSwitchRow
					checked={evolve}
					description={`${t("settings.gui.autoTitleEvolveDesc")} ${t("settings.gui.autoTitleEvolveCost")}`}
					disabled={!enabled}
					icon={<RefreshCw />}
					id="setting-gui-autoTitleEvolve"
					label={t("settings.gui.autoTitleEvolve")}
					onCheckedChange={setEvolve}
				/>
			</div>
		</>
	);
}
