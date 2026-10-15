/**
 * Run settings › Context: how much of the current model's window a session
 * may fill before stock auto-compacts, and stock's extended context windows.
 * Both are stock settings written through set_setting, never an OMPdesk copy:
 * the percentage is this model's `compaction.modelThresholds` entry (the
 * same map Settings › Agent › Compaction limits edits, validated by stock
 * through `compaction_limits`), and the switch is `extendedContext`. Writes
 * replace only the global layer, so a project config's entry stays where it
 * is and the row says so. The line under the select is stock's own resolved
 * "Compacts at" for the model (`useCompactionPoints`).
 */

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
	type CompactionLimit,
	compactionLimitCommitSchema,
	MODEL_THRESHOLDS_PATH,
	useCompactionPoints,
} from "../../lib/compaction-limits";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { toast, toastError } from "../../stores/toast";
import { Select, SwitchField } from "../common";
import { CompactsAt } from "../settings/CompactsAt";

const EXTENDED_CONTEXT_PATH = "extendedContext";
/** The percentages the select offers; any other stored value shows as its own option. */
export const CONTEXT_PERCENTS = [50, 60, 70, 80, 90, 100] as const;
const DEFAULT_OPTION = "default";

type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};

const settingsSchema = z.object({
	values: z.record(z.unknown()),
	provenance: z.record(z.object({ globalValue: z.unknown().optional() }).passthrough()).optional(),
});

interface Loaded {
	/** The global layer's map, which a write replaces. */
	globalLayer: Rec;
	/** The effective entry for this model (any layer). */
	effective: CompactionLimit | undefined;
	extended: boolean | undefined;
}

export function ContextSizeField() {
	const t = useT();
	const rpc = useTabRpc();
	const model = useModelStore(state => state.model);
	const ready = useSessionStore(state => state.status) === "ready";
	const points = useCompactionPoints(ready);
	const selector = model ? `${model.provider}/${model.id}` : null;
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		if (!selector) return;
		const res = await rpc.getSettings([MODEL_THRESHOLDS_PATH, EXTENDED_CONTEXT_PATH]);
		if (!res.success) throw new Error(res.error);
		const parsed = settingsSchema.parse(res.data);
		const effective = asRecord(parsed.values[MODEL_THRESHOLDS_PATH])[selector];
		const extended = parsed.values[EXTENDED_CONTEXT_PATH];
		setLoaded({
			globalLayer: asRecord(parsed.provenance?.[MODEL_THRESHOLDS_PATH]?.globalValue),
			effective: typeof effective === "number" || typeof effective === "string" ? effective : undefined,
			extended: typeof extended === "boolean" ? extended : undefined,
		});
	}, [rpc, selector]);

	useEffect(() => {
		if (!ready || !selector) return;
		setLoaded(null);
		void load().catch(() => setLoaded(null));
	}, [ready, selector, load]);

	if (!selector || !loaded) return null;

	const own = loaded.globalLayer[selector];
	const ownValue = typeof own === "number" || typeof own === "string" ? own : undefined;
	const fromOtherLayer = loaded.effective !== undefined && loaded.effective !== ownValue;
	const current = loaded.effective === undefined ? DEFAULT_OPTION : String(loaded.effective);
	const options = [
		{ value: DEFAULT_OPTION, label: t("input.runSettings.contextDefault") },
		...CONTEXT_PERCENTS.map(percent => ({ value: `${percent}%`, label: `${percent}%` })),
	];
	if (current !== DEFAULT_OPTION && !options.some(option => option.value === current)) {
		options.push({ value: current, label: current });
	}
	const point = points?.bySelector.get(selector);

	const writeLimit = async (choice: string) => {
		setSaving(true);
		try {
			const layer = { ...loaded.globalLayer };
			if (choice === DEFAULT_OPTION) {
				delete layer[selector];
			} else {
				// Stock parses and validates the entry, as the Settings section does.
				const response = await rpc.compactionLimits({ key: selector, input: choice });
				if (!response.success) throw new Error(response.error);
				const commit = compactionLimitCommitSchema.parse(response.data);
				if (!commit.ok) throw new Error(t("input.runSettings.contextInvalid"));
				layer[selector] = commit.value;
			}
			// An empty map unsets the key instead of leaving `modelThresholds: {}` in config.yml.
			const res = await rpc.setSetting(MODEL_THRESHOLDS_PATH, Object.keys(layer).length > 0 ? layer : undefined);
			if (!res.success) throw new Error(res.error);
			await load();
		} catch (error) {
			toastError({ title: t("settings.saveFailed"), error });
		} finally {
			setSaving(false);
		}
	};

	const writeExtended = async (next: boolean) => {
		setSaving(true);
		try {
			const res = await rpc.setSetting(EXTENDED_CONTEXT_PATH, next);
			if (!res.success) throw new Error(res.error);
			await load();
			toast({
				variant: "success",
				message: t(next ? "input.runSettings.extendedOn" : "input.runSettings.extendedOff"),
			});
		} catch (error) {
			toastError({ title: t("settings.saveFailed"), error });
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex flex-col gap-2 px-2 py-1.5" data-context-size="">
			<Select
				controlSize="sm"
				disabled={saving || fromOtherLayer}
				hint={
					<>
						{point && <CompactsAt className="block" point={point} />}
						{fromOtherLayer && <span className="block">{t("compactionLimits.otherLayer")}</span>}
					</>
				}
				label={<span className="text-sc-sm font-normal">{t("input.runSettings.contextLimit")}</span>}
				onChange={event => void writeLimit(event.target.value)}
				options={options}
				value={current}
			/>
			{loaded.extended !== undefined && (
				<SwitchField
					checked={loaded.extended}
					className="-mx-2"
					description={t("input.runSettings.extendedDesc")}
					disabled={saving}
					label={<span className="text-sc-sm font-normal">{t("input.runSettings.extended")}</span>}
					onCheckedChange={next => void writeExtended(next)}
					size="sm"
				/>
			)}
		</div>
	);
}
