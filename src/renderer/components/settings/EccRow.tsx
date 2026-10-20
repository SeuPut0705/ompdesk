/**
 * Settings › Agent behavior › Smart automation: the built-in ECC skill pack (`resources/omp-builtin/ecc`,
 * `shared/ecc.ts`; pref `ecc`, default on). Main reads it per spawn, so a change applies to tabs
 * opened or restarted afterwards.
 */

import { Library } from "lucide-react";
import { ECC_PREF } from "../../../shared/ecc";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

export function EccRow() {
	const t = useT();
	const [on, setOn] = useMainPreference(ECC_PREF, true);
	return (
		<SettingsSwitchRow
			checked={on}
			description={t("settings.gui.eccDesc")}
			icon={<Library />}
			id="setting-gui-ecc"
			label={t("settings.gui.ecc")}
			onCheckedChange={setOn}
		/>
	);
}
