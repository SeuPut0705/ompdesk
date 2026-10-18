/**
 * Settings › Agent behavior › Smart automation: the built-in pstack pack (`resources/omp-builtin/pstack`,
 * `shared/pstack.ts`; pref `pstack`, default on). Main reads it per spawn, so a change applies to tabs
 * opened or restarted afterwards.
 */

import { Layers } from "lucide-react";
import { PSTACK_PREF } from "../../../shared/pstack";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

export function PstackRow() {
	const t = useT();
	const [on, setOn] = useMainPreference(PSTACK_PREF, true);
	return (
		<SettingsSwitchRow
			checked={on}
			description={t("settings.gui.pstackDesc")}
			icon={<Layers />}
			id="setting-gui-pstack"
			label={t("settings.gui.pstack")}
			onCheckedChange={setOn}
		/>
	);
}
