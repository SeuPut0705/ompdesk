/**
 * Settings › Tools & extensions: the OMPdesk control tools (`shared/agent-control.ts`), host tools that let a
 * session's agent see and steer the other sessions: open them, message them, read their transcripts, answer their
 * questions, stop them, show them and notify the user. One switch turns everything on or off (on unless stored
 * `false`; main watches the pref itself and (un)registers the tools on this computer's sessions) and two more
 * tune a human gate:
 *  - approve (default off): an agent may approve another session's tool approval (otherwise only the user does;
 *    an agent approving would bypass the user's own approval policy);
 *  - manage (default on, like the main switch an unset pref is on): an agent may stop or close sessions it did not
 *    open, merge, schedule and start Autopilot without a confirmation card; deleting a saved session it did not open
 *    still asks.
 */

import { AppWindow, ShieldCheck, ShieldQuestion } from "lucide-react";
import {
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
} from "../../../shared/agent-control";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

const SEARCH =
	"ompdesk agent control tools sessions approve approval manage close delete 조작 도구 세션 승인 닫기 삭제";

export function AgentControlRow({ query = "" }: { query?: string }) {
	const t = useT();
	const [on, setOn] = useMainPreference(AGENT_CONTROL_PREF, true);
	const [approve, setApprove] = useMainPreference(AGENT_CONTROL_APPROVE_PREF, false);
	const [manage, setManage] = useMainPreference(AGENT_CONTROL_MANAGE_PREF, true);
	const label = t("settings.gui.agentControl");
	if (query && !`${label} ${SEARCH}`.toLowerCase().includes(query.toLowerCase())) return null;
	return (
		<>
			<SettingsSwitchRow
				checked={on}
				description={t("settings.gui.agentControlDesc")}
				icon={<AppWindow />}
				id="setting-gui-agentControl"
				label={label}
				onCheckedChange={setOn}
			/>
			<SettingsSwitchRow
				checked={approve}
				description={t("settings.gui.agentControlApproveDesc")}
				disabled={!on}
				icon={<ShieldCheck />}
				id="setting-gui-agentControlApprove"
				label={t("settings.gui.agentControlApprove")}
				onCheckedChange={setApprove}
			/>
			<SettingsSwitchRow
				checked={manage}
				description={t("settings.gui.agentControlManageDesc")}
				disabled={!on}
				icon={<ShieldQuestion />}
				id="setting-gui-agentControlManage"
				label={t("settings.gui.agentControlManage")}
				onCheckedChange={setManage}
			/>
		</>
	);
}
