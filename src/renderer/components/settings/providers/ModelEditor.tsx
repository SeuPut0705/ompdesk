/**
 * ModelEditor: expandable per-model detail editor for custom provider configuration.
 * Each model gets ID, name, overrides (endpoint/apiKey/api/maxTokens/headers),
 * cost fields, capabilities, and default flag.
 */

import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { CUSTOM_PROVIDER_APIS, type CustomProviderModelInput } from "../../../../shared/ipc-types";
import { useT } from "../../../lib/i18n";
import { Button } from "../../common";

/** Protocols accepted by models.yml (re-export from shared types). */
const PROVIDER_PROTOCOLS = CUSTOM_PROVIDER_APIS;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type CostField = (typeof COST_FIELDS)[number];

export interface ModelRow extends Omit<CustomProviderModelInput, "id"> {
	key: number;
	id: string;
}

interface ModelEditorProps {
	model: ModelRow;
	readonly: boolean;
	disabled: boolean;
	onUpdate: (key: number, patch: Partial<Omit<ModelRow, "key">>) => void;
	onRemove: (key: number) => void;
	canRemove: boolean;
}

function ModelEditor({ model, readonly, disabled, onUpdate, onRemove, canRemove }: ModelEditorProps) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [costDrafts, setCostDrafts] = useState<Record<CostField, string>>(() => ({
		input: model.cost?.input?.toString() ?? "",
		output: model.cost?.output?.toString() ?? "",
		cacheRead: model.cost?.cacheRead?.toString() ?? "",
		cacheWrite: model.cost?.cacheWrite?.toString() ?? "",
	}));
	// Local record-rows for the per-model headers editor (avoids empty-key
	// collisions in the Record form while editing).
	const [headerRows, setHeaderRows] = useState<Array<[string, string]>>(() => Object.entries(model.headers ?? {}));

	const commitHeaders = (rows: Array<[string, string]>) => {
		setHeaderRows(rows);
		const cleaned = rows.filter(([name]) => name.trim().length > 0);
		onUpdate(model.key, {
			headers: cleaned.length > 0 ? Object.fromEntries(cleaned) : undefined,
		});
	};

	const INPUT_CLASS =
		"w-full rounded-md border border-(--omp-input-border) bg-(--omp-input-bg) px-2.5 py-1.5 text-omp-sm text-(--omp-text) outline-none transition-colors placeholder:text-(--omp-dim) hover:border-(--omp-border-strong) focus:border-(--omp-input-focus-border) disabled:cursor-not-allowed disabled:opacity-60";

	const updateCost = (field: CostField, value: string) => {
		const num = Number.parseFloat(value);
		const cost = {
			...model.cost,
			[field]: value.trim() !== "" && Number.isFinite(num) && num >= 0 ? num : undefined,
		};
		if (COST_FIELDS.every(costField => cost[costField] === undefined)) {
			onUpdate(model.key, { cost: undefined });
		} else {
			onUpdate(model.key, { cost });
		}
	};

	const updateThinkingEfforts = (effort: string, checked: boolean) => {
		if (!model.thinking) return;
		const efforts = checked
			? [...model.thinking.efforts, effort as NonNullable<ModelRow["thinking"]>["efforts"][number]]
			: model.thinking.efforts.filter(e => e !== effort);
		if (efforts.length === 0) {
			onUpdate(model.key, { thinking: undefined });
		} else {
			onUpdate(model.key, { thinking: { ...model.thinking, efforts } });
		}
	};

	const toggleInput = (modality: "text" | "image") => {
		const current = model.input ?? [];
		const next = current.includes(modality)
			? current.filter((m: "text" | "image") => m !== modality)
			: [...current, modality];
		onUpdate(model.key, { input: next.length > 0 ? next : undefined });
	};

	return (
		<div className="rounded-lg border border-(--omp-border-muted) bg-transparent">
			<div className="flex items-center gap-2 px-3 py-2">
				<input
					type="text"
					value={model.id}
					onChange={e => onUpdate(model.key, { id: e.target.value })}
					placeholder={t("providerCfg.form.modelIdPlaceholder")}
					className={`${INPUT_CLASS} flex-1 font-mono`}
					disabled={readonly || disabled}
				/>
				<input
					type="text"
					value={model.name ?? ""}
					onChange={e => onUpdate(model.key, { name: e.target.value || undefined })}
					placeholder={t("providerCfg.form.modelNamePlaceholder")}
					className={`${INPUT_CLASS} flex-1`}
					disabled={readonly || disabled}
				/>
				<Button
					size="sm"
					variant="ghost"
					icon={expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					onClick={() => setExpanded(!expanded)}
					aria-label={expanded ? t("providerCfg.form.modelCollapse") : t("providerCfg.form.modelExpand")}
					disabled={disabled}
				/>
				{canRemove && (
					<Button
						size="sm"
						variant="ghost"
						icon={<Trash2 size={14} />}
						onClick={() => onRemove(model.key)}
						aria-label={t("providerCfg.form.modelRemove")}
						disabled={readonly || disabled}
					/>
				)}
			</div>

			{expanded && (
				<div className="space-y-3 border-t border-(--omp-border-muted) px-3 py-3">
					<div className="grid grid-cols-2 gap-3">
						<label className="flex flex-col gap-1">
							<span className="text-omp-sm font-medium text-(--omp-text)">{t("providerCfg.form.modelApi")}</span>
							<select
								value={model.api ?? ""}
								onChange={e =>
									onUpdate(model.key, {
										api: (e.target.value || undefined) as CustomProviderModelInput["api"],
									})
								}
								className={INPUT_CLASS}
								disabled={readonly || disabled}
							>
								<option value="">{t("providerCfg.form.modelApiInherit")}</option>
								{PROVIDER_PROTOCOLS.map(protocol => (
									<option key={protocol} value={protocol}>
										{protocol}
									</option>
								))}
							</select>
							<span className="text-omp-xs text-(--omp-dim)">{t("providerCfg.form.modelApiHint")}</span>
						</label>

						<label className="flex flex-col gap-1">
							<span className="text-omp-sm font-medium text-(--omp-text)">
								{t("providerCfg.form.modelBaseUrl")}
							</span>
							<input
								type="text"
								value={model.baseUrl ?? ""}
								onChange={e => onUpdate(model.key, { baseUrl: e.target.value || undefined })}
								placeholder={t("providerCfg.form.modelBaseUrlPlaceholder")}
								className={`${INPUT_CLASS} font-mono`}
								disabled={readonly || disabled}
							/>
							<span className="text-omp-xs text-(--omp-dim)">{t("providerCfg.form.modelBaseUrlHint")}</span>
						</label>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<label className="flex flex-col gap-1">
							<span className="text-omp-sm font-medium text-(--omp-text)">
								{t("providerCfg.form.contextWindow")}
							</span>
							<input
								type="number"
								value={model.contextWindow ?? ""}
								onChange={e =>
									onUpdate(model.key, {
										contextWindow: e.target.value ? Number.parseInt(e.target.value, 10) : undefined,
									})
								}
								placeholder="128000"
								min="0"
								className={INPUT_CLASS}
								disabled={readonly || disabled}
							/>
						</label>

						<label className="flex flex-col gap-1">
							<span className="text-omp-sm font-medium text-(--omp-text)">
								{t("providerCfg.form.maxTokens")}
							</span>
							<input
								type="number"
								value={model.maxTokens ?? ""}
								onChange={e =>
									onUpdate(model.key, {
										maxTokens: e.target.value ? Number.parseInt(e.target.value, 10) : undefined,
									})
								}
								placeholder="8192"
								min="0"
								className={INPUT_CLASS}
								disabled={readonly || disabled}
							/>
						</label>
					</div>

					<div className="flex flex-wrap items-center gap-4">
						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={model.reasoning === true}
								onChange={e => onUpdate(model.key, { reasoning: e.target.checked || undefined })}
								disabled={readonly || disabled}
								className="h-4 w-4 rounded border-(--omp-input-border)"
							/>
							<span className="text-omp-sm text-(--omp-text)">{t("providerCfg.form.reasoning")}</span>
						</label>

						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={model.supportsTools === true}
								onChange={e => onUpdate(model.key, { supportsTools: e.target.checked || undefined })}
								disabled={readonly || disabled}
								className="h-4 w-4 rounded border-(--omp-input-border)"
							/>
							<span className="text-omp-sm text-(--omp-text)">{t("providerCfg.form.supportsTools")}</span>
						</label>

						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={model.omitMaxOutputTokens === true}
								onChange={e => onUpdate(model.key, { omitMaxOutputTokens: e.target.checked || undefined })}
								disabled={readonly || disabled}
								className="h-4 w-4 rounded border-(--omp-input-border)"
							/>
							<span className="text-omp-sm text-(--omp-text)">{t("providerCfg.form.omitMaxTokens")}</span>
						</label>
					</div>

					<div className="space-y-2">
						<span className="text-omp-sm font-medium text-(--omp-text)">
							{t("providerCfg.form.inputModalities")}
						</span>
						<div className="flex gap-3">
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={model.input?.includes("text") ?? false}
									onChange={() => toggleInput("text")}
									disabled={readonly || disabled}
									className="h-4 w-4 rounded border-(--omp-input-border)"
								/>
								<span className="text-omp-sm text-(--omp-text)">{t("providerCfg.form.inputText")}</span>
							</label>
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={model.input?.includes("image") ?? false}
									onChange={() => toggleInput("image")}
									disabled={readonly || disabled}
									className="h-4 w-4 rounded border-(--omp-input-border)"
								/>
								<span className="text-omp-sm text-(--omp-text)">{t("providerCfg.form.inputImage")}</span>
							</label>
						</div>
					</div>

					<div className="space-y-2">
						<span className="text-omp-sm font-medium text-(--omp-text)">
							{t("providerCfg.form.thinkingConfig")}
						</span>
						<div className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={!!model.thinking}
								onChange={e => {
									if (e.target.checked) {
										onUpdate(model.key, { thinking: { mode: "effort", efforts: ["medium"] } });
									} else {
										onUpdate(model.key, { thinking: undefined });
									}
								}}
								disabled={readonly || disabled}
								className="h-4 w-4 rounded border-(--omp-input-border)"
							/>
							<span className="text-omp-sm text-(--omp-text)">{t("providerCfg.form.thinkingEnabled")}</span>
						</div>
						{model.thinking && (
							<div className="ml-6 space-y-2">
								<label className="flex flex-col gap-1">
									<span className="text-omp-sm text-(--omp-text)">{t("providerCfg.form.thinkingMode")}</span>
									<select
										value={model.thinking.mode}
										onChange={e =>
											onUpdate(model.key, {
												thinking: {
													...model.thinking!,
													mode: e.target.value as NonNullable<ModelRow["thinking"]>["mode"],
												},
											})
										}
										className={INPUT_CLASS}
										disabled={readonly || disabled}
									>
										<option value="effort">{t("providerCfg.form.thinkingModeEffort")}</option>
										<option value="budget">{t("providerCfg.form.thinkingModeBudget")}</option>
										<option value="google-level">{t("providerCfg.form.thinkingModeGoogle")}</option>
										<option value="anthropic-adaptive">
											{t("providerCfg.form.thinkingModeAnthropicAdaptive")}
										</option>
										<option value="anthropic-budget-effort">
											{t("providerCfg.form.thinkingModeAnthropicBudgetEffort")}
										</option>
									</select>
								</label>

								<div className="space-y-1">
									<span className="text-omp-sm text-(--omp-text)">
										{t("providerCfg.form.thinkingEfforts")}
									</span>
									<div className="flex flex-wrap gap-2">
										{(["minimal", "low", "medium", "high", "xhigh", "max"] as const).map(effort => (
											<label key={effort} className="flex items-center gap-1.5">
												<input
													type="checkbox"
													checked={model.thinking!.efforts.includes(effort)}
													onChange={e => updateThinkingEfforts(effort, e.target.checked)}
													disabled={readonly || disabled}
													className="h-3.5 w-3.5 rounded border-(--omp-input-border)"
												/>
												<span className="text-omp-xs text-(--omp-text)">{effort}</span>
											</label>
										))}
									</div>
								</div>

								<label className="flex items-center gap-2">
									<input
										type="checkbox"
										checked={model.thinking.supportsDisplay === true}
										onChange={e =>
											onUpdate(model.key, {
												thinking: { ...model.thinking!, supportsDisplay: e.target.checked || undefined },
											})
										}
										disabled={readonly || disabled}
										className="h-4 w-4 rounded border-(--omp-input-border)"
									/>
									<span className="text-omp-sm text-(--omp-text)">
										{t("providerCfg.form.thinkingDisplay")}
									</span>
								</label>
							</div>
						)}
					</div>

					<div className="space-y-2">
						<span className="text-omp-sm font-medium text-(--omp-text)">{t("providerCfg.form.costTitle")}</span>
						<span className="block text-omp-xs text-(--omp-dim)">{t("providerCfg.form.costHint")}</span>
						<div className="grid grid-cols-2 gap-2">
							{COST_FIELDS.map(field => (
								<label key={field} className="flex flex-col gap-1">
									<span className="text-omp-xs text-(--omp-text)">{t(`providerCfg.form.cost.${field}`)}</span>
									<input
										type="number"
										value={costDrafts[field]}
										onChange={e => {
											setCostDrafts(current => ({ ...current, [field]: e.target.value }));
											updateCost(field, e.target.value);
										}}
										placeholder="0.00"
										step="any"
										min="0"
										className={INPUT_CLASS}
										disabled={readonly || disabled}
									/>
								</label>
							))}
						</div>
					</div>

					<div className="space-y-2">
						<span className="text-omp-sm font-medium text-(--omp-text)">
							{t("providerCfg.form.modelHeaders")}
						</span>
						<div className="flex flex-col gap-1.5">
							{headerRows.map(([name, value], index) => (
								<div key={index} className="flex items-center gap-2">
									<input
										type="text"
										value={name}
										onChange={e => {
											const next = headerRows.map((row, i) =>
												i === index ? ([e.target.value, value] as [string, string]) : row,
											);
											commitHeaders(next);
										}}
										placeholder={t("providerCfg.form.headerName")}
										className={`${INPUT_CLASS} flex-1 font-mono`}
										disabled={readonly || disabled}
									/>
									<input
										type="text"
										value={value}
										onChange={e => {
											const next = headerRows.map((row, i) =>
												i === index ? ([name, e.target.value] as [string, string]) : row,
											);
											commitHeaders(next);
										}}
										placeholder={t("providerCfg.form.headerValue")}
										className={`${INPUT_CLASS} flex-1 font-mono`}
										disabled={readonly || disabled}
									/>
									<button
										type="button"
										aria-label={t("providerCfg.form.headerRemove")}
										disabled={readonly || disabled}
										onClick={() => commitHeaders(headerRows.filter((_, i) => i !== index))}
										className="shrink-0 text-(--omp-dim) transition-colors hover:text-(--omp-error) disabled:opacity-50"
									>
										<Trash2 size={13} />
									</button>
								</div>
							))}
							{!readonly && (
								<Button
									size="sm"
									variant="ghost"
									icon={<Plus size={12} />}
									disabled={disabled}
									onClick={() => commitHeaders([...headerRows, ["", ""]])}
								>
									{t("providerCfg.form.headerAdd")}
								</Button>
							)}
						</div>
					</div>

					<label className="flex flex-col gap-1">
						<span className="text-omp-sm font-medium text-(--omp-text)">
							{t("providerCfg.form.premiumMultiplier")}
						</span>
						<input
							type="number"
							value={model.premiumMultiplier ?? ""}
							onChange={e =>
								onUpdate(model.key, {
									premiumMultiplier: e.target.value ? Number.parseFloat(e.target.value) : undefined,
								})
							}
							placeholder="1.0"
							step="0.1"
							min="0"
							className={INPUT_CLASS}
							disabled={readonly || disabled}
						/>
						<span className="text-omp-xs text-(--omp-dim)">{t("providerCfg.form.premiumMultiplierHint")}</span>
					</label>
				</div>
			)}
		</div>
	);
}

export { ModelEditor };
