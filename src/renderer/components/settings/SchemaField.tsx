/**
 * SchemaField: a curated agent setting on a Settings page, by path. Uses the
 * human copy `settings.field.<path>` / `.desc` instead of the schema text and
 * hides provenance (Advanced shows it). While the schema is loading the row
 * keeps its label with a skeleton control; a setting this omp does not have,
 * or whose enabling condition is off, renders nothing.
 */

import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { Skeleton } from "../common";
import { SchemaSettingRow } from "./SchemaSettingRow";
import { SettingsRow, SettingsSection, type SettingsSectionProps } from "./SettingsLayout";
import { useSettingsData } from "./settings-data";
import { isSettingVisibleInGui } from "./settings-schema-utils";

/**
 * A Settings section made only of curated schema rows: renders each path as a
 * `SchemaField` and drops the whole section (heading included) once the schema
 * has loaded and none of its rows apply to this omp, so no heading sits empty.
 */
export function SchemaSection({
	paths,
	...section
}: Omit<SettingsSectionProps, "children"> & { paths: readonly string[] }) {
	const { schema, values, loadState, sidecarReady } = useSettingsData();
	if (sidecarReady && loadState === "error") return null;
	if (sidecarReady && loadState === "ready" && schema) {
		const visible = paths.some(path => {
			const entry = schema.entries.find(candidate => candidate.path === path);
			return entry !== undefined && isSettingVisibleInGui(entry, values);
		});
		if (!visible) return null;
	}
	return (
		<SettingsSection {...section}>
			{paths.map(path => (
				<SchemaField key={path} path={path} />
			))}
		</SettingsSection>
	);
}

export function SchemaField({ path, action }: { path: string; action?: ReactNode }) {
	const t = useT();
	const { schema, values, onCommitted, loadState, sidecarReady } = useSettingsData();
	const label = t(`settings.field.${path}`);
	const description = t(`settings.field.${path}.desc`);
	if (!sidecarReady || loadState !== "ready" || !schema) {
		if (loadState === "error" && sidecarReady) return null;
		return (
			<SettingsRow
				control={<Skeleton className="h-(--sc-control-md) w-full rounded-(--sc-radius-md)" />}
				description={description}
				id={`setting-${path}`}
				label={label}
			/>
		);
	}
	const entry = schema.entries.find(candidate => candidate.path === path);
	if (!entry || !isSettingVisibleInGui(entry, values)) return null;
	return (
		<SchemaSettingRow
			action={action}
			description={description}
			entry={entry}
			label={label}
			onCommitted={onCommitted}
			value={values[path]}
		/>
	);
}
