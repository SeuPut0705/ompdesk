import type { SettingEntry } from "../../../shared/rpc-types";
import { useLang, useT } from "../../lib/i18n";
import { Button, EmptyState } from "../common";
import { SchemaSettingRow } from "./SchemaSettingRow";
import { SettingsRow, SettingsSection } from "./SettingsLayout";
import { schemaGroupTitle, schemaSettingText } from "./schema-i18n";
import {
	type AgentSettingsGroup,
	agentSettingsGroup,
	CURATED_SCHEMA_ROWS,
	CUSTOM_SCHEMA_EDITORS,
	type SettingsSectionId,
	schemaSettingsOwner,
} from "./settings-catalog";
import { useSettingsData } from "./settings-data";
import { useSettingsNavigate } from "./settings-navigation";
import { conditionParent, isSettingSupportedInGui, isSettingVisible } from "./settings-schema-utils";

/** The sole schema editor for non-curated settings belonging to this section. */
export function OwnedSchemaSettings({
	section,
	resetPolicies = false,
	group,
	scope,
}: {
	section: SettingsSectionId;
	resetPolicies?: boolean;
	group?: AgentSettingsGroup;
	scope?: "app" | "host";
}) {
	const { lang } = useLang();
	const t = useT();
	const navigate = useSettingsNavigate();
	const { schema, values, onCommitted } = useSettingsData();
	const groups = new Map<string, SettingEntry[]>();
	for (const entry of schema?.entries ?? []) {
		if (
			schemaSettingsOwner(entry) !== section ||
			CURATED_SCHEMA_ROWS[entry.path] ||
			CUSTOM_SCHEMA_EDITORS[entry.path] ||
			!isSettingSupportedInGui(entry)
		)
			continue;
		if (section === "models" && /^(codexResets|claudeResets)\./.test(entry.path) !== resetPolicies) continue;
		if (group && agentSettingsGroup(entry) !== group) continue;
		const title = entry.group ?? entry.tab ?? "";
		const entries = groups.get(title) ?? [];
		entries.push(entry);
		groups.set(title, entries);
	}
	if (section === "advanced" && groups.size === 0 && schema)
		return <EmptyState size="sm" title={t("settings.sectionEmpty")} />;
	return (
		<>
			{[...groups].map(([title, entries]) => (
				<SettingsSection key={title} scope={scope} title={schemaGroupTitle(lang, title)}>
					{entries.map(entry => {
						if (isSettingVisible(entry, values))
							return (
								<SchemaSettingRow
									entry={entry}
									key={entry.path}
									onCommitted={onCommitted}
									showSource
									value={values[entry.path]}
								/>
							);
						const parent = conditionParent(entry.condition);
						return (
							<SettingsRow
								key={entry.path}
								id={`setting-${entry.path}`}
								label={schemaSettingText(lang, entry.path)?.label ?? entry.label ?? entry.path}
								description={t("settings.condition.inactive")}
								control={
									parent ? (
										<Button
											onClick={() =>
												navigate(
													schemaSettingsOwner(
														schema?.entries.find(candidate => candidate.path === parent) ?? {
															path: parent,
														},
													),
													`setting-${parent}`,
												)
											}
											size="sm"
											variant="secondary"
										>
											{t("settings.condition.configure")}
										</Button>
									) : undefined
								}
							/>
						);
					})}
				</SettingsSection>
			))}
		</>
	);
}
