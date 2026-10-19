/**
 * Settings › Agent behavior › Smart automation: let OMPdesk ask the judge model small one-word questions (pref
 * `judgeAssist`, default on). Only while the `judge` role resolves to a native decision model (such as Jev) does
 * anything change; with any other judge model, no key, an error or a timeout every feature keeps its code rule.
 * Main pushes a change to every live local session; a paired host's tab follows the host's pref.
 */

import { Scale } from "lucide-react";
import { JUDGE_ASSIST_PREF } from "../../../../resources/gui-bridge/modes/judge-assist-contracts";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

/** Deep link to the row: Model roles' judge line opens it (`useUiStore.openSettings`). */
export const JUDGE_ASSIST_SETTING_TARGET = "agent:setting-gui-judgeAssist";

export function JudgeAssistRow() {
	const t = useT();
	const [enabled, setEnabled] = useMainPreference(JUDGE_ASSIST_PREF, true);
	return (
		<SettingsSwitchRow
			checked={enabled}
			description={t("settings.gui.judgeAssistDesc")}
			icon={<Scale />}
			id="setting-gui-judgeAssist"
			label={t("settings.gui.judgeAssist")}
			onCheckedChange={setEnabled}
		/>
	);
}
