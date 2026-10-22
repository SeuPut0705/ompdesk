/**
 * ModelEditor: expandable per-model detail editor for custom provider configuration.
 * Each model gets ID, name, overrides (endpoint/apiKey/api/maxTokens/headers),
 * cost fields, capabilities, and default flag.
 */

import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CustomProviderModelInput, CustomProviderOptions } from "../../../../shared/ipc-types";
import { useT } from "../../../lib/i18n";
import { Button, Checkbox, IconButton, Input, Select } from "../../common";

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type CostField = (typeof COST_FIELDS)[number];
const THINKING_MODE_LABELS: Record<string, string> = {
	effort: "providerCfg.form.thinkingModeEffort",
	budget: "providerCfg.form.thinkingModeBudget",
	"google-level": "providerCfg.form.thinkingModeGoogle",
	"anthropic-adaptive": "providerCfg.form.thinkingModeAnthropicAdaptive",
	"anthropic-budget-effort": "providerCfg.form.thinkingModeAnthropicBudgetEffort",
};

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
	options: CustomProviderOptions;
}

function ModelEditor({ model, readonly, disabled, onUpdate, onRemove, canRemove, options }: ModelEditorProps) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	/** The model this row names, so its buttons say which model they act on in a list of several. */
	const named = model.id.trim() || model.name?.trim() || "";
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
		<div className="rounded-(--sc-radius-md) border border-(--sc-border-subtle)">
			<div className="flex items-center gap-2 px-3 py-2">
				<div className="flex-1">
					<Input
						controlSize="sm"
						mono
						aria-label={t("providerCfg.form.modelId")}
						value={model.id}
						onChange={e => onUpdate(model.key, { id: e.target.value })}
						placeholder={t("providerCfg.form.modelIdPlaceholder")}
						disabled={readonly || disabled}
					/>
				</div>
				<div className="flex-1">
					<Input
						controlSize="sm"
						aria-label={t("providerCfg.form.modelName")}
						value={model.name ?? ""}
						onChange={e => onUpdate(model.key, { name: e.target.value || undefined })}
						placeholder={t("providerCfg.form.modelNamePlaceholder")}
						disabled={readonly || disabled}
					/>
				</div>
				<IconButton
					size="sm"
					aria-expanded={expanded}
					icon={expanded ? <ChevronDown /> : <ChevronRight />}
					onClick={() => setExpanded(!expanded)}
					label={
						named ? t("providerCfg.form.modelDetailsFor", { model: named }) : t("providerCfg.form.modelDetails")
					}
					disabled={disabled}
				/>
				{canRemove && (
					<IconButton
						size="sm"
						icon={<Trash2 />}
						onClick={() => onRemove(model.key)}
						label={
							named ? t("providerCfg.form.modelRemoveFor", { model: named }) : t("providerCfg.form.modelRemove")
						}
						disabled={readonly || disabled}
					/>
				)}
			</div>

			{expanded && (
				<div className="space-y-4 border-t border-(--sc-border-subtle) px-3 py-3">
					<div className="grid grid-cols-2 gap-3">
						<Select
							controlSize="sm"
							label={t("providerCfg.form.modelApi")}
							hint={t("providerCfg.form.modelApiHint")}
							value={model.api ?? ""}
							onChange={e =>
								onUpdate(model.key, {
									api: (e.target.value || undefined) as CustomProviderModelInput["api"],
								})
							}
							disabled={readonly || disabled}
						>
							<option value="">{t("providerCfg.form.modelApiInherit")}</option>
							{options.apis.map(protocol => (
								<option key={protocol} value={protocol}>
									{t(`providerCfg.protocol.${protocol}`)}
								</option>
							))}
						</Select>

						<Input
							controlSize="sm"
							mono
							label={t("providerCfg.form.modelBaseUrl")}
							hint={t("providerCfg.form.modelBaseUrlHint")}
							value={model.baseUrl ?? ""}
							onChange={e => onUpdate(model.key, { baseUrl: e.target.value || undefined })}
							placeholder={t("providerCfg.form.modelBaseUrlPlaceholder")}
							disabled={readonly || disabled}
						/>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<Input
							controlSize="sm"
							type="number"
							label={t("providerCfg.form.contextWindow")}
							value={model.contextWindow ?? ""}
							onChange={e =>
								onUpdate(model.key, {
									contextWindow: e.target.value ? Number.parseInt(e.target.value, 10) : undefined,
								})
							}
							placeholder="128000"
							min="0"
							disabled={readonly || disabled}
						/>

						<Input
							controlSize="sm"
							type="number"
							label={t("providerCfg.form.maxTokens")}
							value={model.maxTokens ?? ""}
							onChange={e =>
								onUpdate(model.key, {
									maxTokens: e.target.value ? Number.parseInt(e.target.value, 10) : undefined,
								})
							}
							placeholder="8192"
							min="0"
							disabled={readonly || disabled}
						/>
					</div>

					<div className="flex flex-wrap items-center gap-4">
						<label className="flex items-center gap-2">
							<Checkbox
								checked={model.reasoning === true}
								onChange={e => onUpdate(model.key, { reasoning: e.target.checked || undefined })}
								disabled={readonly || disabled}
							/>
							<span className="text-sc-sm text-(--sc-text)">{t("providerCfg.form.reasoning")}</span>
						</label>
						<label className="flex items-center gap-2">
							<Checkbox
								checked={model.supportsTools === true}
								onChange={e => onUpdate(model.key, { supportsTools: e.target.checked || undefined })}
								disabled={readonly || disabled}
							/>
							<span className="text-sc-sm text-(--sc-text)">{t("providerCfg.form.supportsTools")}</span>
						</label>
						<label className="flex items-center gap-2">
							<Checkbox
								checked={model.omitMaxOutputTokens === true}
								onChange={e => onUpdate(model.key, { omitMaxOutputTokens: e.target.checked || undefined })}
								disabled={readonly || disabled}
							/>
							<span className="text-sc-sm text-(--sc-text)">{t("providerCfg.form.omitMaxTokens")}</span>
						</label>
					</div>

					<div className="space-y-2">
						<span className="block text-sc-xs font-medium uppercase tracking-wide text-(--sc-text-muted)">
							{t("providerCfg.form.inputModalities")}
						</span>
						<div className="flex gap-3">
							<label className="flex items-center gap-2">
								<Checkbox
									checked={model.input?.includes("text") ?? false}
									onChange={() => toggleInput("text")}
									disabled={readonly || disabled}
								/>
								<span className="text-sc-sm text-(--sc-text)">{t("providerCfg.form.inputText")}</span>
							</label>
							<label className="flex items-center gap-2">
								<Checkbox
									checked={model.input?.includes("image") ?? false}
									onChange={() => toggleInput("image")}
									disabled={readonly || disabled}
								/>
								<span className="text-sc-sm text-(--sc-text)">{t("providerCfg.form.inputImage")}</span>
							</label>
						</div>
					</div>

					<div className="space-y-2">
						<span className="block text-sc-xs font-medium uppercase tracking-wide text-(--sc-text-muted)">
							{t("providerCfg.form.thinkingConfig")}
						</span>
						<label className="flex items-center gap-2">
							<Checkbox
								checked={!!model.thinking}
								onChange={e => {
									if (e.target.checked) {
										onUpdate(model.key, { thinking: { mode: "effort", efforts: ["medium"] } });
									} else {
										onUpdate(model.key, { thinking: undefined });
									}
								}}
								disabled={readonly || disabled}
							/>
							<span className="text-sc-sm text-(--sc-text)">{t("providerCfg.form.thinkingEnabled")}</span>
						</label>
						{model.thinking && (
							<div className="ml-6 space-y-3">
								<Select
									controlSize="sm"
									label={t("providerCfg.form.thinkingMode")}
									value={model.thinking.mode}
									onChange={e =>
										onUpdate(model.key, {
											thinking: {
												...model.thinking!,
												mode: e.target.value as NonNullable<ModelRow["thinking"]>["mode"],
											},
										})
									}
									disabled={readonly || disabled}
								>
									{options.thinkingModes.map(mode => (
										<option key={mode} value={mode}>
											{t(THINKING_MODE_LABELS[mode] ?? mode)}
										</option>
									))}
								</Select>

								<div className="space-y-1.5">
									<span className="block text-sc-sm font-medium text-(--sc-text-secondary)">
										{t("providerCfg.form.thinkingEfforts")}
									</span>
									<div className="flex flex-wrap gap-3">
										{options.efforts.map(effort => (
											<label key={effort} className="flex items-center gap-2">
												<Checkbox
													checked={model.thinking!.efforts.some(value => value === effort)}
													onChange={e => updateThinkingEfforts(effort, e.target.checked)}
													disabled={readonly || disabled}
												/>
												<span className="text-sc-xs text-(--sc-text)">{effort}</span>
											</label>
										))}
									</div>
								</div>

								<label className="flex items-center gap-2">
									<Checkbox
										checked={model.thinking.supportsDisplay === true}
										onChange={e =>
											onUpdate(model.key, {
												thinking: { ...model.thinking!, supportsDisplay: e.target.checked || undefined },
											})
										}
										disabled={readonly || disabled}
									/>
									<span className="text-sc-sm text-(--sc-text)">{t("providerCfg.form.thinkingDisplay")}</span>
								</label>
							</div>
						)}
					</div>

					<div className="space-y-2">
						<span className="block text-sc-xs font-medium uppercase tracking-wide text-(--sc-text-muted)">
							{t("providerCfg.form.costTitle")}
						</span>
						<span className="block text-sc-xs text-(--sc-text-muted)">{t("providerCfg.form.costHint")}</span>
						<div className="grid grid-cols-2 gap-2">
							{COST_FIELDS.map(field => (
								<Input
									key={field}
									controlSize="sm"
									type="number"
									label={t(`providerCfg.form.cost.${field}`)}
									value={costDrafts[field]}
									onChange={e => {
										setCostDrafts(current => ({ ...current, [field]: e.target.value }));
										updateCost(field, e.target.value);
									}}
									placeholder="0.00"
									step="any"
									min="0"
									disabled={readonly || disabled}
								/>
							))}
						</div>
					</div>

					<div className="space-y-2">
						<span className="block text-sc-xs font-medium uppercase tracking-wide text-(--sc-text-muted)">
							{t("providerCfg.form.modelHeaders")}
						</span>
						<div className="flex flex-col gap-2">
							{headerRows.map(([name, value], index) => (
								<div key={index} className="flex items-center gap-2">
									<div className="flex-1">
										<Input
											controlSize="sm"
											mono
											aria-label={t("providerCfg.form.headerName")}
											value={name}
											onChange={e => {
												const next = headerRows.map((row, i) =>
													i === index ? ([e.target.value, value] as [string, string]) : row,
												);
												commitHeaders(next);
											}}
											placeholder={t("providerCfg.form.headerName")}
											disabled={readonly || disabled}
										/>
									</div>
									<div className="flex-1">
										<Input
											controlSize="sm"
											mono
											aria-label={t("providerCfg.form.headerValue")}
											value={value}
											onChange={e => {
												const next = headerRows.map((row, i) =>
													i === index ? ([name, e.target.value] as [string, string]) : row,
												);
												commitHeaders(next);
											}}
											placeholder={t("providerCfg.form.headerValue")}
											disabled={readonly || disabled}
										/>
									</div>
									<IconButton
										size="sm"
										icon={<Trash2 />}
										label={
											name.trim()
												? t("providerCfg.form.headerRemoveFor", { header: name.trim() })
												: t("providerCfg.form.headerRemove")
										}
										disabled={readonly || disabled}
										onClick={() => commitHeaders(headerRows.filter((_, i) => i !== index))}
									/>
								</div>
							))}
							{!readonly && (
								<div>
									<Button
										size="sm"
										variant="ghost"
										icon={<Plus />}
										disabled={disabled}
										onClick={() => commitHeaders([...headerRows, ["", ""]])}
									>
										{t("providerCfg.form.headerAdd")}
									</Button>
								</div>
							)}
						</div>
					</div>

					<Input
						controlSize="sm"
						type="number"
						label={t("providerCfg.form.premiumMultiplier")}
						hint={t("providerCfg.form.premiumMultiplierHint")}
						value={model.premiumMultiplier ?? ""}
						onChange={e =>
							onUpdate(model.key, {
								premiumMultiplier: e.target.value ? Number.parseFloat(e.target.value) : undefined,
							})
						}
						placeholder="1.0"
						step="0.1"
						min="0"
						disabled={readonly || disabled}
					/>
				</div>
			)}
		</div>
	);
}

export { ModelEditor };
