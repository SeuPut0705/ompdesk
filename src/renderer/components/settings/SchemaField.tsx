/**
 * SchemaField: a curated agent setting on a Settings page, by path. Uses the
 * human copy `settings.field.<path>` / `.desc` instead of the schema text and
 * hides provenance (Advanced shows it). While the schema is loading the row
 * keeps its label with a skeleton control; a setting this omp does not have,
 * or whose enabling condition is off, renders nothing.
 */

import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { SchemaSettingRow } from "./SchemaSettingRow";
import { SettingsRow } from "./SettingsLayout";
import { useSettingsData } from "./settings-data";
import { isSettingVisibleInGui } from "./settings-schema-utils";

export function SchemaField({ path, action }: { path: string; action?: ReactNode }) {
	const t = useT();
	const { schema, values, onCommitted, loadState, sidecarReady } = useSettingsData();
	const label = t(`settings.field.${path}`);
	const description = t(`settings.field.${path}.desc`);
	if (!sidecarReady || loadState !== "ready" || !schema) {
		if (loadState === "error" && sidecarReady) return null;
		return (
			<SettingsRow
				control={<div aria-hidden className="omp-skeleton h-(--sc-control-md) w-full rounded-(--sc-radius-md)" />}
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
