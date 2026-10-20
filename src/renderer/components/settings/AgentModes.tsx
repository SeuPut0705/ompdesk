import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Button } from "../common";
import { AdvisorModelRow } from "./AdvisorModelRow";
import { SchemaField } from "./SchemaField";
import { useSettingsData } from "./settings-data";

/** The plan, goal, rule and advisor switches; starting goal mode / autopilot or opening Agents lives in the composer and palette. */
export function AgentModes() {
	const t = useT();
	const { values, advisorActive, loadState, sidecarReady } = useSettingsData();
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
		</>
	);
}
