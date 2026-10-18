import { useT } from "../../lib/i18n";
import { AgentModes } from "./AgentModes";
import { AutoModeRow } from "./AutoModeRow";
import { AutoChangesRow, AutoPreviewRow } from "./AutoPanelRows";
import { AutopilotSettingsRows } from "./AutopilotRows";
import { AutoTitleRow } from "./AutoTitleRow";
import { BatchNotificationsRow } from "./BatchNotificationsRow";
import { CompactionLimitsSection } from "./CompactionLimitsSection";
import { NextPromptRow } from "./NextPromptRow";
import { OwnedSchemaSettings, useOwnedSchemaGroups } from "./OwnedSchemaSettings";
import { MemoryReportSection } from "./PluginsSection";
import { ScheduledRetryRow } from "./ScheduledRetryRow";
import { SchemaField } from "./SchemaField";
import { SettingsAdvanced, SettingsSection } from "./SettingsLayout";
import type { AgentSettingsGroup } from "./settings-catalog";
import { useSettingsData } from "./settings-data";
import { isSettingVisibleInGui } from "./settings-schema-utils";

const MESSAGE_PATHS = [
	"steeringMode",
	"followUpMode",
	"interruptMode",
	"retry.modelFallback",
	"retry.maxRetries",
	"tui.renderMermaid",
];

/** Agent's four groups, in order, with their heading; their stock (non-curated) rows fold under Advanced. */
const AGENT_GROUPS: readonly { group: AgentSettingsGroup; titleKey: string }[] = [
	{ group: "messages", titleKey: "settings.agent.messages" },
	{ group: "modes", titleKey: "settings.agent.modes" },
	{ group: "context", titleKey: "settings.agent.context" },
	{ group: "io", titleKey: "settings.agent.io" },
];

/**
 * Settings › Agent behavior: the curated rows of messages & execution, modes,
 * and context & memory; every other stock agent setting folds under Advanced,
 * still grouped the same way (search breadcrumbs keep those group names).
 */
export function AgentSection() {
	const t = useT();
	const { schema, values } = useSettingsData();
	const stockGroups = {
		messages: useOwnedSchemaGroups({ section: "agent", group: "messages" }).size > 0,
		modes: useOwnedSchemaGroups({ section: "agent", group: "modes" }).size > 0,
		context: useOwnedSchemaGroups({ section: "agent", group: "context" }).size > 0,
		io: useOwnedSchemaGroups({ section: "agent", group: "io" }).size > 0,
	} satisfies Record<AgentSettingsGroup, boolean>;
	const hasMessages =
		!schema ||
		schema.entries.some(entry => MESSAGE_PATHS.includes(entry.path) && isSettingVisibleInGui(entry, values));
	return (
		<>
			{hasMessages && (
				<SettingsSection id="settings-agent-messages" title={t("settings.agent.messages")}>
					{MESSAGE_PATHS.map(path => (
						<SchemaField key={path} path={path} />
					))}
				</SettingsSection>
			)}
			<SettingsSection id="settings-agent-suggestions" scope="app" title={t("settings.agent.suggestions")}>
				<NextPromptRow />
			</SettingsSection>
			<SettingsSection id="settings-agent-titles" scope="app" title={t("settings.agent.titles")}>
				<AutoTitleRow />
			</SettingsSection>
			<SettingsSection id="settings-agent-automation" scope="app" title={t("settings.agent.automation")}>
				<AutoPreviewRow />
				<AutoChangesRow />
				<BatchNotificationsRow />
				<ScheduledRetryRow />
				<AutoModeRow />
				<AutopilotSettingsRows />
			</SettingsSection>
			<SettingsSection id="settings-agent-modes" title={t("settings.agent.modes")}>
				<AgentModes />
			</SettingsSection>
			<SettingsSection id="settings-agent-context" title={t("settings.agent.context")}>
				<SchemaField path="compaction.enabled" />
				<CompactionLimitsSection />
				<SchemaField path="memory.backend" />
				<MemoryReportSection />
			</SettingsSection>
			{AGENT_GROUPS.some(({ group }) => stockGroups[group]) && (
				<SettingsAdvanced>
					{AGENT_GROUPS.filter(({ group }) => stockGroups[group]).map(({ group, titleKey }) => (
						<SettingsSection id={`settings-agent-${group}-more`} key={group} title={t(titleKey)}>
							<OwnedSchemaSettings group={group} section="agent" />
						</SettingsSection>
					))}
				</SettingsAdvanced>
			)}
		</>
	);
}
