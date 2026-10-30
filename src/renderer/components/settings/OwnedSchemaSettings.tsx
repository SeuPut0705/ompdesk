import type { ReactNode } from "react";
import type { SettingEntry } from "../../../shared/rpc-types";
import { useLang, useT } from "../../lib/i18n";
import { Button, EmptyState } from "../common";
import { SchemaSettingRow } from "./SchemaSettingRow";
import { SettingsAdvanced, SettingsRow, SettingsSection } from "./SettingsLayout";
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

interface OwnedSchemaFilter {
	section: SettingsSectionId;
	resetPolicies?: boolean;
	group?: AgentSettingsGroup;
}

/** A section's non-curated schema entries, by their stock group title. */
export function ownedSchemaGroups(
	schema: { entries: readonly SettingEntry[] } | null | undefined,
	{ section, resetPolicies = false, group }: OwnedSchemaFilter,
) {
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
	return groups;
}

export function useOwnedSchemaGroups(filter: OwnedSchemaFilter) {
	const { schema } = useSettingsData();
	return ownedSchemaGroups(schema, filter);
}

/**
 * A section's non-curated stock settings folded under Advanced (with `children`
 * first, when given); nothing at all when there is nothing to fold.
 */
export function AdvancedSchemaSettings({
	section,
	scope,
	title,
	id,
	children,
}: {
	section: SettingsSectionId;
	scope?: "app" | "host";
	/** Groups the stock rows under one heading (their stock groups nest under it). */
	title?: string;
	id?: string;
	children?: ReactNode;
}) {
	const groups = useOwnedSchemaGroups({ section });
	if (groups.size === 0 && children === undefined) return null;
	const rows = groups.size > 0 && <OwnedSchemaSettings scope={scope} section={section} />;
	return (
		<SettingsAdvanced>
			{children}
			{rows && title ? (
				<SettingsSection id={id} title={title}>
					{rows}
				</SettingsSection>
			) : (
				rows
			)}
		</SettingsAdvanced>
	);
}

/** The sole schema editor for non-curated settings belonging to this section. */
export function OwnedSchemaSettings({
	section,
	resetPolicies = false,
	group,
	scope,
}: OwnedSchemaFilter & { scope?: "app" | "host" }) {
	const { lang } = useLang();
	const t = useT();
	const navigate = useSettingsNavigate();
	const { schema, values, onCommitted } = useSettingsData();
	const groups = useOwnedSchemaGroups({ section, resetPolicies, group });
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
