/**
 * Settings › Features: what omp adds on top of a chat — modes, rules,
 * the advisor, memory, subagents — each with its on/off switch where omp has
 * one and a link to its full configuration. Quick commands and the command
 * palette are entry points, not settings.
 */

import { prefillComposer } from "../../lib/command-registry";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Banner, Button, Kbd } from "../common";
import { SchemaField } from "./SchemaField";
import { SettingsRow, SettingsSection } from "./SettingsLayout";
import { useSettingsData } from "./settings-data";
import { useSettingsNavigate } from "./settings-navigation";

const QUICK_COMMANDS = [
	{ label: "cmd.btw", text: "/btw " },
	{ label: "cmd.tan", text: "/tan " },
	{ label: "cmd.omfg", text: "/omfg " },
	{ label: "cmd.guidedGoal", text: "/guided-goal " },
	{ label: "cmd.queue", text: "-> " },
] as const;

export function FeaturesSection() {
	const t = useT();
	const navigate = useSettingsNavigate();
	const { values, advisorActive, loadState, sidecarReady } = useSettingsData();
	const leaveTo = (open: () => void) => {
		useUiStore.getState().closeDestination();
		open();
	};
	const advisorIdle =
		sidecarReady && loadState === "ready" && values["advisor.enabled"] === true && advisorActive === false;

	return (
		<>
			<SettingsSection title={t("settings.features.start")}>
				<SettingsRow
					control={
						<Button
							data-command-center-entry
							onClick={() => leaveTo(() => useUiStore.getState().openCommandPalette())}
							size="sm"
							trailingIcon={<Kbd shortcut="⌘K" />}
							variant="secondary"
						>
							{t("settings.features.openPalette")}
						</Button>
					}
					description={t("settings.features.paletteDesc")}
					id="settings-features-palette"
					label={t("settings.features.palette")}
				/>
				<SettingsRow
					description={t("settings.features.quickDesc")}
					id="settings-features-quick"
					label={t("settings.features.quick")}
				>
					<div className="flex flex-wrap gap-2">
						{QUICK_COMMANDS.map(command => (
							<Button
								key={command.label}
								onClick={() => leaveTo(() => prefillComposer(command.text))}
								size="sm"
								variant="secondary"
							>
								{t(command.label)}
							</Button>
						))}
					</div>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection description={t("settings.features.modesDesc")} title={t("settings.features.modes")}>
				<SchemaField path="plan.enabled" />
				<SchemaField path="goal.enabled" />
				<SettingsRow
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
								onClick={() => leaveTo(() => useUiStore.getState().openModes("loop"))}
								size="sm"
								variant="secondary"
							>
								{t("settings.features.loop")}
							</Button>
						</div>
					}
					description={t("settings.features.runModesDesc")}
					label={t("settings.features.runModes")}
				/>
			</SettingsSection>

			<SettingsSection title={t("settings.features.helpers")}>
				<SchemaField
					action={
						<Button
							onClick={() => navigate("advanced:context", "setting-ttsr.enabled")}
							size="sm"
							variant="ghost"
						>
							{t("settings.features.configureRules")}
						</Button>
					}
					path="ttsr.enabled"
				/>
				<SchemaField
					action={
						<Button
							onClick={() => navigate("advanced:model", "setting-advisor.enabled")}
							size="sm"
							variant="ghost"
						>
							{t("settings.features.configureAdvisor")}
						</Button>
					}
					path="advisor.enabled"
				/>
				{advisorIdle && (
					<Banner
						actions={
							<Button onClick={() => navigate("models:roles")} size="sm" variant="secondary">
								{t("settings.features.configureRoles")}
							</Button>
						}
						className="my-2"
						variant="info"
					>
						{t("settings.features.advisorIdle")}
					</Banner>
				)}
				<SchemaField
					action={
						<Button onClick={() => navigate("advanced:memory")} size="sm" variant="ghost">
							{t("settings.features.configureMemory")}
						</Button>
					}
					path="memory.backend"
				/>
			</SettingsSection>

			<SettingsSection title={t("settings.features.agents")}>
				<SettingsRow
					control={
						<Button
							onClick={() => leaveTo(() => useUiStore.getState().openAgents("definitions"))}
							size="sm"
							variant="secondary"
						>
							{t("settings.features.openAgents")}
						</Button>
					}
					description={t("settings.features.subagentsDesc")}
					label={t("settings.features.subagents")}
				/>
				<SettingsRow
					control={
						<Button onClick={() => navigate("models:roles")} size="sm" variant="secondary">
							{t("settings.features.configureRoles")}
						</Button>
					}
					description={t("settings.features.rolesDesc")}
					label={t("settings.features.roles")}
				/>
				<SettingsRow
					control={
						<Button onClick={() => navigate("advanced:tools")} size="sm" variant="secondary">
							{t("settings.features.configureTools")}
						</Button>
					}
					description={t("settings.features.toolsDesc")}
					label={t("settings.features.tools")}
				/>
			</SettingsSection>
		</>
	);
}
