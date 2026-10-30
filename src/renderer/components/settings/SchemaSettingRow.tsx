/**
 * SchemaSettingRow: one agent-schema setting as a Settings row. Booleans are
 * a switch row; enums a Select; numbers/strings a field; arrays and records
 * a structured editor (JSON as the fallback) under the label. Writes go
 * through set_setting and apply immediately.
 *
 * `label`/`description` override the schema text (curated rows); `showSource`
 * (Advanced only) reveals where a configured value comes from.
 */

import {
	Brain,
	Check,
	ChevronRight,
	Eye,
	EyeOff,
	KeyRound,
	Lightbulb,
	ListChecks,
	ListPlus,
	type LucideIcon,
	MessageSquarePlus,
	OctagonX,
	RotateCw,
	ScrollText,
	ShieldCheck,
	ShieldQuestion,
	Shrink,
	Shuffle,
	Target,
	Workflow,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { SettingEntry, SettingProvenance } from "../../../shared/rpc-types";
import { useLang, useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useTabRpc } from "../../lib/tab-rpc";
import { toastError } from "../../stores/toast";
import { Badge, Button, IconButton, Input, Select, Spinner, TextArea } from "../common";
import { ArrayChipEditor } from "./editors/ArrayChipEditor";
import { ProviderLimitsEditor } from "./editors/ProviderLimitsEditor";
import { RecordKvEditor } from "./editors/RecordKvEditor";
import { type ModelValueGroup, ModelValueSelect, settingRefKind } from "./ModelValueSelect";
import { SettingsRow, SettingsSwitchRow } from "./SettingsLayout";
import { schemaOptionText, schemaSettingText } from "./schema-i18n";

const COMMON_SHELLS: readonly ModelValueGroup[] = [
	{
		label: "",
		options: [
			"/bin/zsh",
			"/bin/bash",
			"/bin/sh",
			"/bin/fish",
			"/usr/bin/zsh",
			"/usr/bin/bash",
			"/usr/local/bin/zsh",
			"/usr/local/bin/bash",
			"/opt/homebrew/bin/zsh",
			"/opt/homebrew/bin/bash",
			"/opt/homebrew/bin/fish",
		].map(path => ({ value: path })),
	},
];

/**
 * The glyph a curated row wears, so it lines up with the GUI rows of its group (icon + label + control). Raw stock
 * rows under Advanced have none: none of them do.
 */
const CURATED_ICONS: Readonly<Record<string, LucideIcon>> = {
	steeringMode: MessageSquarePlus,
	followUpMode: ListPlus,
	interruptMode: OctagonX,
	"compaction.enabled": Shrink,
	"tui.renderMermaid": Workflow,
	defaultThinkingLevel: Brain,
	"retry.modelFallback": Shuffle,
	"retry.maxRetries": RotateCw,
	"tools.approvalMode": ShieldCheck,
	"tools.approval": ShieldQuestion,
	"secrets.enabled": KeyRound,
	"plan.enabled": ListChecks,
	"goal.enabled": Target,
	"ttsr.enabled": ScrollText,
	"advisor.enabled": Lightbulb,
};

function SettingStatus({ dirty, saving, saved }: { dirty: boolean; saving: boolean; saved: boolean }) {
	const t = useT();
	if (saving) return <Spinner label={t("common.saving")} size="sm" spin />;
	if (dirty) return <Badge variant="warning">{t("common.unsaved")}</Badge>;
	if (saved)
		return (
			<span className="flex shrink-0 items-center gap-0.5 text-sc-xs text-(--sc-success)">
				<Check aria-hidden className="size-(--sc-icon-sm)" />
				{t("common.saved")}
			</span>
		);
	return null;
}

/** `thinkingBudgets.high` → "Thinking budgets · high": a stock key nobody labelled still reads as words. */
export function humanizeSettingPath(path: string): string {
	return path
		.split(".")
		.map(part =>
			part
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.replace(/[_-]+/g, " ")
				.toLowerCase(),
		)
		.join(" · ")
		.replace(/^./, first => first.toUpperCase());
}

function draftFor(entry: SettingEntry, value: unknown): string {
	if (entry.type === "array" || entry.type === "record") {
		return JSON.stringify(value ?? (entry.type === "array" ? [] : {}), null, 2);
	}
	return value === undefined || value === null ? "" : String(value);
}

/**
 * Boolean settings whose one direction lowers a safeguard: the switch asks to
 * accept the risk before it writes that value (`SettingsSwitchRow` `risk`).
 */
export const RISKY_SETTINGS: Readonly<Record<string, { value: boolean; warning: string }>> = {
	"secrets.enabled": { value: false, warning: "settings.risk.secrets" },
	"share.redactSecrets": { value: false, warning: "settings.risk.shareRedact" },
	"bash.gitGuard": { value: false, warning: "settings.risk.gitGuard" },
};

function SchemaSettingRow({
	entry,
	value,
	onCommitted,
	label: labelOverride,
	description: descriptionOverride,
	showSource = false,
	action,
}: {
	entry: SettingEntry;
	value: unknown;
	onCommitted: (path: string, value: unknown) => void;
	/** Curated copy replacing the schema label. */
	label?: string;
	description?: string;
	/** Advanced view: show which config layer a configured value comes from. */
	showSource?: boolean;
	/** A follow-up link under the row ("Configure rules"). */
	action?: ReactNode;
}) {
	const tabRpc = useTabRpc();
	const [draft, setDraft] = useState<string | null>(null);
	const t = useT();
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedProvenance, setSavedProvenance] = useState<SettingProvenance>();
	const [revealed, setRevealed] = useState(false);
	const savedTimer = useRef<number | undefined>(undefined);

	const generation = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a different session client or setting invalidates pending saves.
	useEffect(() => {
		generation.current++;
		setDraft(null);
		setError(null);
		setSaving(false);
		setSaved(false);
		setSavedProvenance(undefined);
		return () => {
			generation.current++;
		};
	}, [tabRpc, entry.path]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fresh schema provenance replaces a previous save acknowledgement.
	useEffect(() => {
		setSavedProvenance(undefined);
	}, [entry.provenance]);

	useEffect(
		() => () => {
			window.clearTimeout(savedTimer.current);
		},
		[],
	);

	const { lang } = useLang();
	const localized = schemaSettingText(lang, entry.path);
	const unlabelled = labelOverride === undefined && !localized?.label && !entry.label;
	const label = labelOverride ?? localized?.label ?? entry.label ?? humanizeSettingPath(entry.path);
	const description = descriptionOverride ?? localized?.description ?? entry.description;
	const controlId = useId();
	const baseDraft = draftFor(entry, value);
	const dirty = draft !== null && draft !== baseDraft;

	const commit = useCallback(
		async (next: unknown) => {
			const requestGeneration = ++generation.current;
			setSaving(true);
			try {
				const res = await tabRpc.setSetting(entry.path, next);
				if (generation.current !== requestGeneration) return;
				if (res.success) {
					const data = res.data as { value?: unknown; provenance?: SettingProvenance } | undefined;
					if (data?.provenance) {
						onCommitted(entry.path, data.value);
						setSavedProvenance(data.provenance);
					} else {
						// Older cores returned the submitted value; read back the effective value.
						const readback = await tabRpc.getSettings([entry.path]);
						if (generation.current !== requestGeneration) return;
						if (!readback.success) throw new Error(readback.error);
						const effective = readback.data as { values?: Record<string, unknown> } | undefined;
						if (!effective?.values) throw new Error(t("settings.savedUnverified"));
						onCommitted(entry.path, effective.values[entry.path]);
					}
					setDraft(null);
					setError(null);
					if (entry.type !== "boolean") {
						setSaved(true);
						window.clearTimeout(savedTimer.current);
						savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
					}
				} else {
					// The toast carries the raw cause; the inline line stays localized.
					setError(t("settings.saveFailed"));
					toastError({ title: t("settings.saveFailed"), error: res });
				}
			} catch (err) {
				if (generation.current !== requestGeneration) return;
				setError(t("settings.saveFailed"));
				toastError({ title: t("settings.saveFailed"), error: err });
			} finally {
				if (generation.current === requestGeneration) setSaving(false);
			}
		},
		[entry.path, entry.type, onCommitted, t, tabRpc],
	);

	// Escape discards the draft; the blur that follows must not commit it.
	const discardOnBlur = useRef(false);
	const commitText = useCallback(() => {
		if (discardOnBlur.current) {
			discardOnBlur.current = false;
			return;
		}
		if (draft === null || draft === baseDraft) {
			setDraft(null);
			setError(null);
			return;
		}
		if (entry.type === "number") {
			const trimmed = draft.trim();
			const num = Number(trimmed);
			if (trimmed.length === 0 || !Number.isFinite(num)) {
				setError(t("settings.editors.errNumber"));
				return;
			}
			void commit(num);
			return;
		}
		void commit(draft);
	}, [draft, baseDraft, entry.type, commit, t]);

	const commitJson = useCallback(() => {
		if (draft === null || draft === baseDraft) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(draft);
		} catch (err) {
			setError(t("settings.editors.errInvalidJson", { error: err instanceof Error ? err.message : String(err) }));
			return;
		}
		if (entry.type === "array" && !Array.isArray(parsed)) {
			setError(t("settings.editors.errJsonArray"));
			return;
		}
		if (entry.type === "record" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
			setError(t("settings.editors.errJsonObject"));
			return;
		}
		void commit(parsed);
	}, [draft, baseDraft, entry.type, commit, t]);

	const onTextKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "Enter") event.currentTarget.blur();
		if (event.key === "Escape" && draft !== null) {
			// A pending edit claims this Escape; the next one leaves the page.
			event.preventDefault();
			event.stopPropagation();
			discardOnBlur.current = true;
			setDraft(null);
			setError(null);
			event.currentTarget.blur();
		}
	};

	const status = <SettingStatus dirty={dirty} saving={saving} saved={saved} />;
	// Values cached at session construction need a restart in every client.
	const badge = (
		<>
			{entry.restartRequired === true && (
				<span title={t("settings.restartRequired.hint")}>
					<Badge variant="warning">{t("settings.restartRequired.badge")}</Badge>
				</span>
			)}
			{status}
		</>
	);
	const provenance = savedProvenance ?? entry.provenance;
	// The source disclosure is an Advanced detail, and only meaningful once some layer configures the value.
	const footer = (
		<>
			{action && <div className="mt-1.5">{action}</div>}
			{entry.note === "native" && (
				<p className="mt-1 text-sc-xs text-(--sc-text-muted)">{t("settings.note.native")}</p>
			)}
			{entry.default === undefined && value !== undefined && (
				<div className="mt-1">
					<Button disabled={saving} onClick={() => void commit(undefined)} size="sm" variant="ghost">
						{t("settings.restoreUnset")}
					</Button>
				</div>
			)}
			{error && (
				<p className="mt-1 text-sc-xs text-(--sc-danger)" role="alert">
					{error}
				</p>
			)}
			{showSource && provenance && provenance.layers.length > 0 && (
				<details className="group/source mt-1 text-sc-xs text-(--sc-text-muted)">
					<summary className="flex min-h-(--sc-control-sm) w-fit max-w-full cursor-pointer list-none items-center gap-1 rounded-(--sc-radius-sm) select-none hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring) [&::-webkit-details-marker]:hidden">
						<ChevronRight aria-hidden className="size-3 shrink-0 group-open/source:rotate-90" />
						<span className="min-w-0">
							{t("settings.source.label")}:{" "}
							{provenance.layers.map(layer => t(`settings.source.${layer}`)).join(" → ")}
						</span>
					</summary>
					<p className="mt-1">{t("settings.source.saveGlobal")}</p>
					<code className="mt-1 block font-mono break-words whitespace-pre-wrap">
						{entry.secret ? "••••••" : (JSON.stringify(provenance.globalValue) ?? t("settings.source.default"))}
					</code>
					{provenance.globalPath && <p className="mt-1 break-all font-mono">{provenance.globalPath}</p>}
				</details>
			)}
		</>
	);
	const rowId = `setting-${entry.path}`;
	// Where stock sets no default an empty field means "not set", not a forgotten value.
	const emptyHint = entry.default === undefined ? t("settings.valueUnset") : undefined;
	// A key with no label of its own keeps its id beside the words, in small mono, so it can still be looked up.
	const rowLabel = (
		<>
			<span title={entry.path}>{label}</span>
			{unlabelled && (
				<code className="ml-2 font-mono text-sc-2xs font-normal break-all text-(--sc-text-muted)">
					{entry.path}
				</code>
			)}
		</>
	);
	const CuratedIcon = CURATED_ICONS[entry.path];
	const icon = CuratedIcon ? <CuratedIcon /> : undefined;

	// Boolean settings write immediately; the switch position is the feedback.
	if (entry.type === "boolean") {
		const risk = RISKY_SETTINGS[entry.path];
		return (
			<SettingsSwitchRow
				badge={badge}
				checked={value === true}
				description={description}
				disabled={saving}
				footer={footer}
				icon={icon}
				id={rowId}
				label={rowLabel}
				onCheckedChange={next => void commit(next)}
				risk={risk && { value: risk.value, warning: t(risk.warning) }}
			/>
		);
	}

	// Arrays and records get a full-width editor under the label.
	if (entry.type === "array" || entry.type === "record") {
		const masked = entry.secret === true && !revealed;
		// Structured editors for the common shapes; JSON stays the fallback.
		const stringArray =
			entry.type === "array" &&
			// Empty rule lists still contain objects; the current value cannot
			// determine their editor until the first rule exists.
			entry.path !== "bash.patterns" &&
			entry.path !== "bashInterceptor.patterns" &&
			Array.isArray(value) &&
			(value as unknown[]).every(item => typeof item === "string");
		const nestedRecord = entry.path === "images.urls.options" || entry.path === "images.urls.credentials";
		const flatRecord =
			entry.type === "record" &&
			!nestedRecord &&
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.values(value as Record<string, unknown>).every(
				item => item === null || ["string", "number", "boolean"].includes(typeof item),
			);
		const approvalOptions =
			entry.path === "tools.approval"
				? [
						{ value: "allow", label: t("settings.editors.approval.allow") },
						{ value: "prompt", label: t("settings.editors.approval.prompt") },
						{ value: "deny", label: t("settings.editors.approval.deny") },
					]
				: undefined;
		// Model-valued records (modelRoles) get a model dropdown per value cell.
		const modelValued = entry.path === "modelRoles";
		// Per-provider concurrency caps get the dedicated provider+number editor.
		const providerLimits =
			entry.path === "providers.maxInFlightRequests" &&
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value);
		let editor: ReactNode;
		if (masked) {
			editor = (
				<div className="flex items-center justify-between rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-3 py-2">
					<span className="text-sc-sm text-(--sc-text-muted)">••••••••</span>
					<Button icon={<Eye />} onClick={() => setRevealed(true)} size="sm" type="button" variant="ghost">
						{t("common.reveal")}
					</Button>
				</div>
			);
		} else if (stringArray) {
			editor = (
				<ArrayChipEditor
					disabled={saving}
					onCommit={next => void commit(next)}
					ordered={entry.ordered === true}
					options={entry.options?.map(option => ({
						value: option.value,
						label: schemaOptionText(lang, option.label),
					}))}
					values={value as string[]}
				/>
			);
		} else if (providerLimits) {
			editor = (
				<ProviderLimitsEditor
					disabled={saving}
					onCommit={next => void commit(next)}
					value={value as Record<string, unknown>}
				/>
			);
		} else if (flatRecord) {
			editor = (
				<RecordKvEditor
					disabled={saving}
					onCommit={next => void commit(next)}
					value={value as Record<string, unknown>}
					valueKind={modelValued ? "model" : undefined}
					valueOptions={approvalOptions}
				/>
			);
		} else {
			editor = (
				<>
					<TextArea
						aria-label={label}
						autoGrow
						disabled={saving}
						error={error ?? undefined}
						mono
						onChange={event => {
							setDraft(event.target.value);
							setError(null);
						}}
						rows={3}
						spellCheck={false}
						value={draft ?? baseDraft}
					/>
					<div className="mt-2 flex items-center justify-end gap-2">
						{entry.secret === true && (
							<Button
								icon={<EyeOff />}
								onClick={() => setRevealed(false)}
								size="sm"
								type="button"
								variant="ghost"
							>
								{t("common.hide")}
							</Button>
						)}
						{dirty && (
							<Button
								onClick={() => {
									setDraft(null);
									setError(null);
								}}
								size="sm"
								type="button"
								variant="ghost"
							>
								{t("common.reset")}
							</Button>
						)}
						<Button
							disabled={!dirty || saving}
							loading={saving}
							onClick={commitJson}
							size="sm"
							type="button"
							variant="secondary"
						>
							{t("common.apply")}
						</Button>
					</div>
				</>
			);
		}
		return (
			<SettingsRow badge={badge} description={description} footer={footer} icon={icon} id={rowId} label={rowLabel}>
				{editor}
			</SettingsRow>
		);
	}

	// enum / number / string: label left, control in the right column.
	let control: ReactNode;
	if (entry.type === "enum") {
		const options = entry.options ?? [];
		const current = typeof value === "string" ? value : undefined;
		const hasCurrent = current !== undefined && options.some(option => option.value === current);
		control =
			options.length === 0 ? (
				<Input
					disabled={saving}
					id={controlId}
					onBlur={commitText}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={onTextKeyDown}
					placeholder={emptyHint}
					value={draft ?? baseDraft}
				/>
			) : (
				<Select
					disabled={saving}
					id={controlId}
					onChange={event => {
						if (event.target.value !== "") void commit(event.target.value);
					}}
					value={current ?? ""}
				>
					{current === undefined && <option value="">{t("common.unset")}</option>}
					{!hasCurrent && current !== undefined && <option value={current}>{current}</option>}
					{options.map(option => (
						<option
							key={option.value}
							title={option.description && schemaOptionText(lang, option.description)}
							value={option.value}
						>
							{schemaOptionText(lang, option.label)}
						</option>
					))}
				</Select>
			);
	} else if (entry.type === "number") {
		control = (
			<Input
				disabled={saving}
				error={error ?? undefined}
				id={controlId}
				placeholder={emptyHint}
				onBlur={commitText}
				onChange={event => {
					setDraft(event.target.value);
					setError(null);
				}}
				onKeyDown={onTextKeyDown}
				type="number"
				value={draft ?? baseDraft}
			/>
		);
	} else {
		const masked = entry.secret === true && !revealed;
		// Enumerable string settings get dropdowns (never hand-typed); then
		// model/provider references get searchable dropdowns; secrets stay text.
		const refKind = entry.secret === true ? null : settingRefKind(entry.path);
		if (entry.secret !== true && entry.path === "shellPath") {
			control = (
				<ModelValueSelect
					allowCustom
					disabled={saving}
					groups={COMMON_SHELLS}
					noun={t("settings.editors.shells")}
					onCommit={next => void commit(next)}
					value={typeof value === "string" ? value : ""}
				/>
			);
		} else if (refKind !== null) {
			control = (
				<ModelValueSelect
					disabled={saving}
					kind={refKind}
					onCommit={next => void commit(next)}
					value={typeof value === "string" ? value : ""}
				/>
			);
		} else {
			control = (
				<Input
					disabled={saving}
					id={controlId}
					onBlur={commitText}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={onTextKeyDown}
					placeholder={emptyHint}
					trailing={
						entry.secret === true ? (
							<IconButton
								icon={masked ? <Eye /> : <EyeOff />}
								label={masked ? t("common.revealValue") : t("common.hideValue")}
								onClick={() => setRevealed(!revealed)}
								size="sm"
							/>
						) : undefined
					}
					type={masked ? "password" : "text"}
					value={draft ?? baseDraft}
				/>
			);
		}
	}

	return (
		<SettingsRow
			badge={badge}
			control={control}
			description={description}
			icon={icon}
			footer={footer}
			htmlFor={controlId}
			id={rowId}
			label={rowLabel}
		/>
	);
}

export { SchemaSettingRow };
