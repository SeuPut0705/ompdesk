import { Network, Workflow } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Button } from "../common";
import { AdvisorModelRow } from "./AdvisorModelRow";
import { SchemaField } from "./SchemaField";
import { SettingsRow } from "./SettingsLayout";
import { useSettingsData } from "./settings-data";

/** Host defaults and explicit current-session actions; model assignment lives in Models. */
export function AgentModes() {
	const t = useT();
	const { values, advisorActive, loadState, sidecarReady } = useSettingsData();
	const leaveTo = (open: () => void) => {
		useUiStore.getState().closeDestination();
		open();
	};
	return (
		<>
			<SchemaField path="plan.enabled" />
			<SchemaField path="goal.enabled" />
			<SchemaField path="ttsr.enabled" />
			<SchemaField
				path="advisor.enabled"
				action={
					<Button onClick={() => useUiStore.getState().openModelSetup()} size="sm" variant="ghost">
						{t("modelSetup.open")}
					</Button>
				}
			/>
			{sidecarReady && loadState === "ready" && values["advisor.enabled"] === true && (
				<AdvisorModelRow active={advisorActive} sidecarReady={sidecarReady} />
			)}
			<SettingsRow
				icon={<Workflow />}
				label={t("settings.features.runModes")}
				description={t("settings.features.runModesDesc")}
				control={
					<div className="flex justify-end gap-2">
						<Button
							onClick={() => leaveTo(() => useUiStore.getState().openModes("goal"))}
							size="sm"
							variant="secondary"
						>
							{t("settings.features.goal")}
						</Button>
						<Button
							onClick={() => leaveTo(() => useUiStore.getState().openModes("autopilot"))}
							size="sm"
							variant="secondary"
						>
							{t("settings.features.autopilot")}
						</Button>
					</div>
				}
			/>
			<SettingsRow
				icon={<Network />}
				label={t("settings.features.subagents")}
				description={t("settings.features.subagentsDesc")}
				control={
					<Button
						onClick={() => leaveTo(() => useUiStore.getState().openAgents("definitions"))}
						size="sm"
						variant="secondary"
					>
						{t("settings.features.openAgents")}
					</Button>
				}
			/>
		</>
	);
}
