/**
 * Settings › Tools & extensions: the OMPdesk control tools (`shared/agent-control.ts`), host tools that let a
 * session's agent see and steer the other sessions: open them, message them, read their transcripts, answer their
 * questions, stop them, show them and notify the user. The first row is full control (default on, unset counts as
 * on): no confirmation card at all, the agent may approve for other sessions and change these switches. Then the
 * main switch (on unless stored `false`; main watches the pref itself and (un)registers the tools on this
 * computer's sessions) and two human gates that full control covers while it is on:
 *  - approve (default off): an agent may approve another session's tool approval (otherwise only the user does;
 *    an agent approving would bypass the user's own approval policy);
 *  - manage (default on, like the main switch an unset pref is on): an agent may stop or close sessions it did not
 *    open, merge, schedule and start Autopilot without a confirmation card; deleting a saved session it did not open
 *    still asks.
 */

import { AppWindow, ShieldCheck, ShieldOff, ShieldQuestion } from "lucide-react";
import {
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_FULL_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
} from "../../../shared/agent-control";
import { useT } from "../../lib/i18n";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

const SEARCH =
	"ompdesk agent control tools sessions approve approval manage close delete full 조작 도구 세션 승인 닫기 삭제 모든 권한";

export function AgentControlRow({ query = "" }: { query?: string }) {
	const t = useT();
	const [full, setFull] = useMainPreference(AGENT_CONTROL_FULL_PREF, true);
	const [on, setOn] = useMainPreference(AGENT_CONTROL_PREF, true);
	const [approve, setApprove] = useMainPreference(AGENT_CONTROL_APPROVE_PREF, true);
	const [manage, setManage] = useMainPreference(AGENT_CONTROL_MANAGE_PREF, true);
	const label = t("settings.gui.agentControl");
	if (query && !`${label} ${SEARCH}`.toLowerCase().includes(query.toLowerCase())) return null;
	const covered = on && full;
	return (
		<>
			<SettingsSwitchRow
				checked={full}
				description={t("settings.gui.agentControlFullDesc")}
				disabled={!on}
				icon={<ShieldOff />}
				id="setting-gui-agentControlFull"
				label={t("settings.gui.agentControlFull")}
				onCheckedChange={setFull}
			/>
			<SettingsSwitchRow
				checked={on}
				description={t("settings.gui.agentControlDesc")}
				icon={<AppWindow />}
				id="setting-gui-agentControl"
				label={label}
				onCheckedChange={setOn}
			/>
			<SettingsSwitchRow
				checked={covered || approve}
				description={covered ? t("settings.gui.agentControlCovered") : t("settings.gui.agentControlApproveDesc")}
				disabled={!on || covered}
				icon={<ShieldCheck />}
				id="setting-gui-agentControlApprove"
				label={t("settings.gui.agentControlApprove")}
				onCheckedChange={setApprove}
			/>
			<SettingsSwitchRow
				checked={covered || manage}
				description={covered ? t("settings.gui.agentControlCovered") : t("settings.gui.agentControlManageDesc")}
				disabled={!on || covered}
				icon={<ShieldQuestion />}
				id="setting-gui-agentControlManage"
				label={t("settings.gui.agentControlManage")}
				onCheckedChange={setManage}
			/>
		</>
	);
}
