/**
 * Settings › Models & providers › Compaction limits: per-model auto-compaction
 * points (`compaction.modelThresholds`, omp 18.8.5+), the GUI side of the
 * Roles view's "Compaction limit" in stock's `/models` hub. Each row is one
 * `provider/model-id` (or `provider/…*` prefix) with a token count or a
 * percentage of the context window; adding a model that already has a limit
 * replaces it. Writes the global layer through set_setting, so stock persists
 * and validates it; entries another layer (a project config) sets show
 * read-only. Renders nothing on an omp whose live schema lacks the setting.
 * Advanced keeps the raw JSON row for what this does not edit (`null`
 * entries that clear an inherited key).
 */

import { Plus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { z } from "zod";
import type { SettingProvenance } from "../../../shared/rpc-types";
import {
	type CompactionLimit,
	compactionLimitCommitSchema,
	compactionLimitsSchema,
	MODEL_THRESHOLDS_PATH,
	useCompactionPoints,
} from "../../lib/compaction-limits";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useTabRpc } from "../../lib/tab-rpc";
import { toast, toastError } from "../../stores/toast";
import { Button, IconButton, Input } from "../common";
import { CompactsAt } from "./CompactsAt";
import { ModelValueSelect } from "./ModelValueSelect";
import { SettingsRow, SettingsSection } from "./SettingsLayout";
import { useSettingsData } from "./settings-data";

type Rec = Record<string, unknown>;

const asRecord = (value: unknown): Rec =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};

/** set_setting's answer: the effective value after the write and where it now comes from. */
const setResultSchema = z.object({
	value: z.unknown(),
	provenance: z
		.object({
			layers: z.array(z.enum(["global", "project", "overlay", "runtime"])),
			globalValue: z.unknown(),
			globalPath: z.string().optional(),
		})
		.optional(),
});

export function CompactionLimitsSection() {
	const t = useT();
	const tabRpc = useTabRpc();
	const { schema, values, sidecarReady, onCommitted } = useSettingsData();
	const entry = schema?.entries.find(candidate => candidate.path === MODEL_THRESHOLDS_PATH);
	const points = useCompactionPoints(entry !== undefined);
	const [savedProvenance, setSavedProvenance] = useState<SettingProvenance>();
	const [saving, setSaving] = useState(false);
	const [model, setModel] = useState("");
	const [limit, setLimit] = useState("");
	const [modelError, setModelError] = useState<string | null>(null);
	const [limitError, setLimitError] = useState<string | null>(null);
	const limitId = useId();
	const [rows, setRows] = useState<Array<{ key: string; value: CompactionLimit; text: string }>>([]);
	const [loadingRows, setLoadingRows] = useState(true);
	const rawLimits = values[MODEL_THRESHOLDS_PATH];
	useEffect(() => {
		if (!sidecarReady || !entry) return;
		let current = true;
		setLoadingRows(true);
		void tabRpc
			.compactionLimits({ values: rawLimits })
			.then(response => {
				if (!response.success) throw new Error(response.error);
				const result = compactionLimitsSchema.parse(response.data);
				if (current) setRows(result.rows);
			})
			.catch(error => {
				if (current) {
					setRows([]);
					toastError({ title: t("settings.saveFailed"), error });
				}
			})
			.finally(() => {
				if (current) setLoadingRows(false);
			});
		return () => {
			current = false;
		};
	}, [rawLimits, sidecarReady, entry, tabRpc, t]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: fresh schema provenance (config_update) replaces the one the last save returned.
	useEffect(() => {
		setSavedProvenance(undefined);
	}, [entry?.provenance]);

	if (!entry) return null;

	const provenance = savedProvenance ?? entry.provenance;
	// The global layer alone is what a write replaces; project entries must not be copied into it.
	const globalLayer = provenance?.layers.includes("global") ? asRecord(provenance.globalValue) : {};
	const disabled = saving || !sidecarReady;

	const write = async (key: string, next: CompactionLimit | undefined): Promise<boolean> => {
		const layer = { ...globalLayer };
		if (next === undefined) delete layer[key];
		else layer[key] = next;
		setSaving(true);
		try {
			// An empty map unsets the key instead of leaving `modelThresholds: {}` in config.yml.
			const res = await tabRpc.setSetting(MODEL_THRESHOLDS_PATH, Object.keys(layer).length > 0 ? layer : undefined);
			if (!res.success) {
				toastError({ title: t("settings.saveFailed"), error: res });
				return false;
			}
			const data = setResultSchema.safeParse(res.data);
			if (!data.success) throw new Error(t("settings.savedUnverified"));
			const effective = asRecord(data.data.value);
			onCommitted(MODEL_THRESHOLDS_PATH, data.data.value);
			if (data.data.provenance) setSavedProvenance(data.data.provenance);
			// Stock's own rule: a higher layer setting the same key leaves the global write without effect.
			const landed =
				next === undefined ? effective[key] === undefined || effective[key] === null : effective[key] === next;
			if (!landed) {
				toast({ variant: "warning", message: t("compactionLimits.overridden", { model: key }) });
				return false;
			}
			return true;
		} catch (error) {
			toastError({ title: t("settings.saveFailed"), error });
			return false;
		} finally {
			setSaving(false);
		}
	};

	const add = async () => {
		const key = model.trim();
		setSaving(true);
		try {
			const response = await tabRpc.compactionLimits({ key, input: limit });
			if (!response.success) throw new Error(response.error);
			const parsed = compactionLimitCommitSchema.parse(response.data);
			setModelError(!parsed.ok && parsed.modelError ? t(`compactionLimits.err.model.${parsed.modelError}`) : null);
			setLimitError(!parsed.ok && parsed.limitError ? t(`compactionLimits.err.limit.${parsed.limitError}`) : null);
			if (!parsed.ok) return;
			if (await write(key, parsed.value)) {
				setModel("");
				setLimit("");
			}
		} catch (error) {
			toastError({ title: t("settings.saveFailed"), error });
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			description={t("compactionLimits.desc")}
			id="settings-models-compaction-limits"
			title={t("compactionLimits.title")}
		>
			<div className="divide-y divide-(--sc-divider)">
				{rows.map(({ key, value, text }) => {
					const own = Object.hasOwn(globalLayer, key) && globalLayer[key] === value;
					const point = key.endsWith("*") ? undefined : points?.bySelector.get(key);
					return (
						<SettingsRow
							control={
								<div className="flex items-center justify-end gap-2">
									<span className="font-mono text-sc-sm tabular-nums text-(--sc-text)">{text}</span>
									{own && (
										<IconButton
											disabled={disabled}
											icon={<X />}
											label={t("compactionLimits.remove", { model: key })}
											onClick={() => void write(key, undefined)}
											size="sm"
										/>
									)}
								</div>
							}
							description={
								point || !own ? (
									<>
										{point && <CompactsAt className="block" point={point} />}
										{!own && <span className="block">{t("compactionLimits.otherLayer")}</span>}
									</>
								) : undefined
							}
							id={`compaction-limit-${key}`}
							key={key}
							label={
								<span className="font-mono" title={key}>
									{key}
								</span>
							}
						/>
					);
				})}
				{rows.length === 0 && (
					<p className="py-3 text-sc-sm text-(--sc-text-muted)">
						{t(loadingRows ? "common.loading" : "compactionLimits.empty")}
					</p>
				)}
				<SettingsRow
					description={t("compactionLimits.addHint")}
					id="compaction-limits-add"
					label={t("compactionLimits.addLabel")}
				>
					<div className="flex flex-wrap items-start gap-2">
						<div className="min-w-[min(100%,16rem)] flex-1">
							<ModelValueSelect
								ariaLabel={t("compactionLimits.model")}
								disabled={disabled}
								kind="model"
								onCommit={next => {
									setModel(next);
									setModelError(null);
								}}
								placeholder={t("compactionLimits.pickModel")}
								value={model}
							/>
							{modelError && (
								<p className="mt-1 text-sc-xs text-(--sc-danger)" role="alert">
									{modelError}
								</p>
							)}
						</div>
						<div className="w-36 shrink-0">
							<Input
								aria-label={t("compactionLimits.limit")}
								controlSize="sm"
								disabled={disabled}
								error={limitError ?? undefined}
								id={limitId}
								mono
								onChange={event => {
									setLimit(event.target.value);
									setLimitError(null);
								}}
								onKeyDown={event => {
									if (isImeKeyEvent(event)) return;
									if (event.key === "Enter") void add();
								}}
								placeholder={t("compactionLimits.limitPlaceholder")}
								spellCheck={false}
								value={limit}
							/>
						</div>
						<Button disabled={disabled} icon={<Plus />} onClick={() => void add()} size="sm">
							{t("compactionLimits.add")}
						</Button>
					</div>
				</SettingsRow>
			</div>
		</SettingsSection>
	);
}
