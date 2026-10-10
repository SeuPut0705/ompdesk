import { useT } from "../../lib/i18n";
import { AgentModes } from "./AgentModes";
import { CompactionLimitsSection } from "./CompactionLimitsSection";
import { OwnedSchemaSettings } from "./OwnedSchemaSettings";
import { MemoryReportSection } from "./PluginsSection";
import { SchemaField } from "./SchemaField";
import { SettingsSection } from "./SettingsLayout";

import {
	agentSettingsGroup,
	CURATED_SCHEMA_ROWS,
	CUSTOM_SCHEMA_EDITORS,
	schemaSettingsOwner,
} from "./settings-catalog";
import { useSettingsData } from "./settings-data";
import { isSettingSupportedInGui, isSettingVisibleInGui } from "./settings-schema-utils";

const MESSAGE_PATHS = [
	"steeringMode",
	"followUpMode",
	"interruptMode",
	"retry.modelFallback",
	"retry.maxRetries",
	"tui.renderMermaid",
];
export function AgentSection() {
	const t = useT();
	const { schema, values } = useSettingsData();
	const hasMessages =
		!schema ||
		schema.entries.some(
			entry =>
				(MESSAGE_PATHS.includes(entry.path) && isSettingVisibleInGui(entry, values)) ||
				(schemaSettingsOwner(entry) === "agent" &&
					agentSettingsGroup(entry) === "messages" &&
					!CURATED_SCHEMA_ROWS[entry.path] &&
					!CUSTOM_SCHEMA_EDITORS[entry.path] &&
					isSettingSupportedInGui(entry)),
		);
	return (
		<>
			{hasMessages && (
				<SettingsSection id="settings-agent-messages" title={t("settings.agent.messages")}>
					{MESSAGE_PATHS.map(path => (
						<SchemaField key={path} path={path} />
					))}
					<OwnedSchemaSettings section="agent" group="messages" />
				</SettingsSection>
			)}
			<SettingsSection id="settings-agent-modes" title={t("settings.agent.modes")}>
				<AgentModes />
				<OwnedSchemaSettings section="agent" group="modes" />
			</SettingsSection>
			<SettingsSection id="settings-agent-context" title={t("settings.agent.context")}>
				<SchemaField path="compaction.enabled" />
				<CompactionLimitsSection />
				<SchemaField path="memory.backend" />
				<OwnedSchemaSettings section="agent" group="context" />
				<MemoryReportSection />
			</SettingsSection>
			<SettingsSection id="settings-agent-io" title={t("settings.agent.io")}>
				<OwnedSchemaSettings section="agent" group="io" />
			</SettingsSection>
		</>
	);
}
