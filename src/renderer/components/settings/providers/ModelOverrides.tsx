/**
 * Settings › Models & providers › Model overrides (B43): change a model a
 * provider already has — built-in ones included — through stock models.yml
 * `providers.<id>.modelOverrides.<model>`: display name, context window, max
 * output, reasoning on/off, its reasoning levels with the value each sends on
 * the wire, the wire format (api), and whether earlier reasoning is replayed
 * with tool calls. An empty field inherits the model's own value; Reset
 * removes the override so the model is as shipped again. Keys this editor does
 * not show survive an edit (main's setModelOverride merges over the entry).
 */

import { Pencil, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import type {
	CustomModelEffort,
	CustomModelThinkingMode,
	CustomProviderApi,
	ModelOverrideInput,
} from "../../../../shared/ipc-types";
import { errorDetail } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useFocusedTabDevice } from "../../../stores/remote";
import { toast, toastError } from "../../../stores/toast";
import { Button, ConfirmDialog, IconButton, Input, ListRow, Modal, Select } from "../../common";
import { SettingsSection } from "../SettingsLayout";
import type { ProviderCatalog } from "./ProviderList";

type Tri = "" | "on" | "off";
const TRI: Record<string, Tri> = { "": "", on: "on", off: "off" };
/** Stock's reasoning ladder, in order; the editor offers the ones stock's options list. */
const EFFORT_ORDER: readonly CustomModelEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

interface Draft {
	provider: string;
	modelId: string;
	name: string;
	contextWindow: string;
	maxTokens: string;
	/** "" = the model's own (the Select offers stock's api list). */
	api: CustomProviderApi | "";
	reasoning: Tri;
	replay: Tri;
	/** "" = the model's own reasoning levels (the Select offers stock's thinking modes). */
	thinkingMode: CustomModelThinkingMode | "";
	efforts: CustomModelEffort[];
	effortMap: Partial<Record<CustomModelEffort, string>>;
}

interface Target {
	provider: string;
	modelId: string;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

const triOf = (value: boolean | undefined): Tri => (value === undefined ? "" : value ? "on" : "off");
const boolOf = (value: Tri): boolean | undefined => (value === "" ? undefined : value === "on");

function draftOf(target: Target, override: ModelOverrideInput | undefined): Draft {
	return {
		...target,
		name: override?.name ?? "",
		contextWindow: override?.contextWindow?.toString() ?? "",
		maxTokens: override?.maxTokens?.toString() ?? "",
		api: override?.api ?? "",
		reasoning: triOf(override?.reasoning),
		replay: triOf(override?.replayReasoning),
		thinkingMode: override?.thinking?.mode ?? "",
		efforts: override?.thinking?.efforts ?? [],
		effortMap: override?.thinking?.effortMap ?? {},
	};
}

/** A positive whole number, or undefined for an empty field; null when the text is neither. */
function tokenCount(text: string): number | undefined | null {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const value = Number(trimmed);
	return Number.isInteger(value) && value > 0 ? value : null;
}

/** The draft as stock fields, or the message key of its first problem. */
export function overrideFromDraft(draft: Draft): { override: ModelOverrideInput } | { problem: string } {
	const contextWindow = tokenCount(draft.contextWindow);
	const maxTokens = tokenCount(draft.maxTokens);
	if (contextWindow === null || maxTokens === null) return { problem: "modelOverrides.problem.number" };
	if (draft.thinkingMode && draft.efforts.length === 0) return { problem: "modelOverrides.problem.levels" };
	const override: ModelOverrideInput = {};
	if (draft.name.trim()) override.name = draft.name.trim();
	if (contextWindow !== undefined) override.contextWindow = contextWindow;
	if (maxTokens !== undefined) override.maxTokens = maxTokens;
	if (draft.api) override.api = draft.api;
	const reasoning = boolOf(draft.reasoning);
	if (reasoning !== undefined) override.reasoning = reasoning;
	const replay = boolOf(draft.replay);
	if (replay !== undefined) override.replayReasoning = replay;
	if (draft.thinkingMode) {
		const effortMap: Partial<Record<CustomModelEffort, string>> = {};
		for (const effort of draft.efforts) {
			const wire = draft.effortMap[effort]?.trim();
			if (wire) effortMap[effort] = wire;
		}
		override.thinking = {
			mode: draft.thinkingMode,
			efforts: draft.efforts,
			...(Object.keys(effortMap).length > 0 ? { effortMap } : {}),
		};
	}
	return { override };
}

/** One line naming what an override changes. */
function summary(override: ModelOverrideInput, t: Translate): string {
	const parts: string[] = [];
	if (override.name) parts.push(override.name);
	if (override.contextWindow)
		parts.push(t("modelOverrides.summary.context", { count: override.contextWindow.toLocaleString() }));
	if (override.maxTokens)
		parts.push(t("modelOverrides.summary.output", { count: override.maxTokens.toLocaleString() }));
	if (override.reasoning !== undefined)
		parts.push(t(override.reasoning ? "modelOverrides.summary.reasoningOn" : "modelOverrides.summary.reasoningOff"));
	if (override.thinking)
		parts.push(t("modelOverrides.summary.levels", { levels: override.thinking.efforts.join(", ") }));
	if (override.api) parts.push(override.api);
	if (override.replayReasoning !== undefined)
		parts.push(t(override.replayReasoning ? "modelOverrides.summary.replayOn" : "modelOverrides.summary.replayOff"));
	return parts.join(" · ") || t("modelOverrides.summary.none");
}

export function ModelOverrides({ catalog }: { catalog: ProviderCatalog }) {
	const t = useT();
	const device = useFocusedTabDevice();
	const refreshProviders = useModelStore(state => state.refreshProviders);
	const [editing, setEditing] = useState<Draft | null>(null);
	const [pendingReset, setPendingReset] = useState<Target | null>(null);
	const [busy, setBusy] = useState(false);
	const rows = catalog.customConfigs.flatMap(config =>
		Object.entries(config.modelOverrides ?? {}).map(([modelId, override]) => ({
			provider: config.id,
			modelId,
			override,
		})),
	);

	const write = async (target: Target, override: ModelOverrideInput | null): Promise<boolean> => {
		setBusy(true);
		try {
			await window.omp.models.setModelOverride(target.provider, target.modelId, override, device);
			try {
				await refreshProviders(true);
			} catch (cause) {
				toast({ variant: "warning", message: t("providerCfg.toast.refreshFailed"), detail: errorDetail(cause) });
			}
			await catalog.load();
			const model = `${target.provider}/${target.modelId}`;
			toast({
				variant: "success",
				message: t(override ? "modelOverrides.saved" : "modelOverrides.reset", { model }),
			});
			return true;
		} catch (cause) {
			toastError({ title: t("modelOverrides.saveFailed"), error: cause });
			return false;
		} finally {
			setBusy(false);
		}
	};

	return (
		<SettingsSection
			actions={
				<Button
					data-model-override-add
					disabled={!catalog.options}
					icon={<Plus />}
					onClick={() => setEditing(draftOf({ provider: "", modelId: "" }, undefined))}
					size="sm"
					variant="secondary"
				>
					{t("modelOverrides.add")}
				</Button>
			}
			description={t("modelOverrides.description")}
			id="settings-models-overrides"
			title={t("modelOverrides.title")}
		>
			{rows.length === 0 ? (
				<p className="py-2 text-sc-sm text-(--sc-text-muted)">{t("modelOverrides.empty")}</p>
			) : (
				<ul>
					{rows.map(row => (
						<li key={`${row.provider}/${row.modelId}`}>
							<ListRow
								actions={
									<>
										<IconButton
											icon={<Pencil />}
											label={t("modelOverrides.edit", { model: `${row.provider}/${row.modelId}` })}
											onClick={() => setEditing(draftOf(row, row.override))}
											size="sm"
										/>
										<IconButton
											icon={<RotateCcw />}
											label={t("modelOverrides.resetLabel", { model: `${row.provider}/${row.modelId}` })}
											onClick={() => setPendingReset(row)}
											size="sm"
										/>
									</>
								}
								description={summary(row.override, t)}
								onClick={() => setEditing(draftOf(row, row.override))}
								rowProps={{ "data-model-override": `${row.provider}/${row.modelId}` }}
								title={<span className="font-mono">{`${row.provider}/${row.modelId}`}</span>}
								titleText={`${row.provider}/${row.modelId}`}
							/>
						</li>
					))}
				</ul>
			)}
			{editing && catalog.options && (
				<OverrideEditor
					apis={catalog.options.apis}
					busy={busy}
					draft={editing}
					efforts={EFFORT_ORDER.filter(effort => catalog.options?.efforts.includes(effort))}
					isNew={!rows.some(row => row.provider === editing.provider && row.modelId === editing.modelId)}
					onCancel={() => setEditing(null)}
					onSave={async (target, override) => {
						if (await write(target, override)) setEditing(null);
					}}
					thinkingModes={catalog.options.thinkingModes}
				/>
			)}
			<ConfirmDialog
				busy={busy}
				confirmLabel={t("modelOverrides.resetConfirm")}
				message={t("modelOverrides.resetBody", {
					model: pendingReset ? `${pendingReset.provider}/${pendingReset.modelId}` : "",
				})}
				onCancel={() => setPendingReset(null)}
				onConfirm={() => {
					const target = pendingReset;
					if (target) void write(target, null).then(() => setPendingReset(null));
				}}
				open={pendingReset !== null}
				title={t("modelOverrides.resetTitle")}
			/>
		</SettingsSection>
	);
}

function OverrideEditor({
	draft: initial,
	isNew,
	apis,
	efforts,
	thinkingModes,
	busy,
	onCancel,
	onSave,
}: {
	draft: Draft;
	isNew: boolean;
	apis: string[];
	efforts: CustomModelEffort[];
	thinkingModes: string[];
	busy: boolean;
	onCancel: () => void;
	onSave: (target: Target, override: ModelOverrideInput) => Promise<void>;
}) {
	const t = useT();
	const models = useModelStore(state => state.availableModels);
	const [draft, setDraft] = useState(initial);
	const [problem, setProblem] = useState<string | null>(null);
	const patch = (next: Partial<Draft>) => setDraft(current => ({ ...current, ...next }));
	const key = draft.provider ? `${draft.provider}/${draft.modelId}` : "";
	const current = models.find(model => model.provider === draft.provider && model.id === draft.modelId);
	const triOptions = [
		{ value: "", label: t("modelOverrides.inherit") },
		{ value: "on", label: t("modelOverrides.on") },
		{ value: "off", label: t("modelOverrides.off") },
	];

	const save = () => {
		if (!draft.provider || !draft.modelId) {
			setProblem("modelOverrides.problem.model");
			return;
		}
		const result = overrideFromDraft(draft);
		if ("problem" in result) {
			setProblem(result.problem);
			return;
		}
		setProblem(null);
		void onSave({ provider: draft.provider, modelId: draft.modelId }, result.override);
	};

	return (
		<Modal
			footer={
				<>
					<Button onClick={onCancel} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button data-model-override-save loading={busy} onClick={save} size="sm" variant="primary">
						{t("common.save")}
					</Button>
				</>
			}
			onClose={onCancel}
			open
			size="md"
			title={isNew ? t("modelOverrides.add") : t("modelOverrides.editTitle", { model: key })}
		>
			<div className="flex flex-col gap-3" data-model-override-editor>
				{isNew && (
					<Select
						data-model-override-model
						label={t("modelOverrides.model")}
						onChange={event => {
							const value = event.target.value;
							const slash = value.indexOf("/");
							patch(
								slash < 0
									? { provider: "", modelId: "" }
									: { provider: value.slice(0, slash), modelId: value.slice(slash + 1) },
							);
						}}
						options={[
							{ value: "", label: t("modelOverrides.pickModel") },
							...models.map(model => ({
								value: `${model.provider}/${model.id}`,
								label: `${model.provider}/${model.id}`,
							})),
						]}
						value={key}
					/>
				)}
				<Input
					label={t("modelOverrides.name")}
					onChange={event => patch({ name: event.target.value })}
					placeholder={current?.name ?? draft.modelId}
					value={draft.name}
				/>
				<div className="grid grid-cols-2 gap-3">
					<Input
						data-model-override-context
						inputMode="numeric"
						label={t("modelOverrides.contextWindow")}
						onChange={event => patch({ contextWindow: event.target.value })}
						placeholder={current?.contextWindow ? String(current.contextWindow) : t("modelOverrides.inherit")}
						value={draft.contextWindow}
					/>
					<Input
						inputMode="numeric"
						label={t("modelOverrides.maxTokens")}
						onChange={event => patch({ maxTokens: event.target.value })}
						placeholder={current?.maxTokens ? String(current.maxTokens) : t("modelOverrides.inherit")}
						value={draft.maxTokens}
					/>
				</div>
				<div className="grid grid-cols-2 gap-3">
					<Select
						label={t("modelOverrides.api")}
						// The options are stock's own api vocabulary (CustomProvidersConfig.options).
						onChange={event => patch({ api: event.target.value as Draft["api"] })}
						options={[
							{ value: "", label: t("modelOverrides.inherit") },
							...apis.map(api => ({ value: api, label: api })),
						]}
						value={draft.api}
					/>
					<Select
						label={t("modelOverrides.reasoning")}
						onChange={event => patch({ reasoning: TRI[event.target.value] ?? "" })}
						options={triOptions}
						value={draft.reasoning}
					/>
				</div>
				<Select
					hint={t("modelOverrides.replayHint")}
					label={t("modelOverrides.replay")}
					onChange={event => patch({ replay: TRI[event.target.value] ?? "" })}
					options={triOptions}
					value={draft.replay}
				/>
				<Select
					data-model-override-mode
					hint={t("modelOverrides.levelsHint")}
					label={t("modelOverrides.levels")}
					// The options are stock's own thinking modes (CustomProvidersConfig.options).
					onChange={event => patch({ thinkingMode: event.target.value as Draft["thinkingMode"] })}
					options={[
						{ value: "", label: t("modelOverrides.inherit") },
						...thinkingModes.map(mode => ({ value: mode, label: mode })),
					]}
					value={draft.thinkingMode}
				/>
				{draft.thinkingMode && (
					<fieldset className="flex flex-col gap-1.5" data-model-override-levels>
						<legend className="sr-only">{t("modelOverrides.levels")}</legend>
						{efforts.map(effort => {
							const checked = draft.efforts.includes(effort);
							return (
								<div className="flex items-center gap-3" key={effort}>
									<label className="inline-flex w-28 items-center gap-2 text-sc-sm text-(--sc-text)">
										<input
											checked={checked}
											className="accent-(--sc-accent)"
											data-model-override-effort={effort}
											onChange={() =>
												patch({
													// Keep stock's ladder order whatever order they are ticked in.
													efforts: efforts.filter(candidate =>
														candidate === effort ? !checked : draft.efforts.includes(candidate),
													),
												})
											}
											type="checkbox"
										/>
										{effort}
									</label>
									{checked && (
										<div className="min-w-0 flex-1">
											<Input
												aria-label={t("modelOverrides.wireValue", { level: effort })}
												controlSize="sm"
												mono
												onChange={event =>
													patch({ effortMap: { ...draft.effortMap, [effort]: event.target.value } })
												}
												placeholder={effort}
												value={draft.effortMap[effort] ?? ""}
											/>
										</div>
									)}
								</div>
							);
						})}
					</fieldset>
				)}
				{problem && (
					<p className="text-sc-sm text-(--sc-danger)" role="alert">
						{t(problem)}
					</p>
				)}
			</div>
		</Modal>
	);
}
