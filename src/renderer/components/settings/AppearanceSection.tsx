/**
 * Settings › Appearance: theme (inline swatches), text size and density,
 * and how conversations render. Every control applies immediately.
 */

import {
	Brain,
	Check,
	ClipboardPaste,
	Eye,
	EyeOff,
	Gauge,
	ListOrdered,
	Monitor,
	Palette,
	PanelTop,
	Rows3,
	ScrollText,
	Shrink,
	Smile,
	Target,
	TextQuote,
	Type,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
	GUI_DISPLAY_BOOL_FIELDS,
	saveGuiPreference,
	setDisplayPreference,
	useDisplayPreference,
} from "../../lib/display-preferences";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { setCodeLineNumbersPref } from "../../lib/markdown";
import {
	applyThemeByName,
	getPersistedThemeSelection,
	resolveTokenColor,
	THEMES,
	type ThemeDefinition,
	type ThemeName,
	type ThemeSelection,
} from "../../lib/themes";
import { toast } from "../../stores/toast";
import { type TranscriptDetail, useUiStore } from "../../stores/ui";
import { Button, Input, Select } from "../common";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";

const THEME_SELECTIONS: readonly ThemeSelection[] = ["system", ...(Object.keys(THEMES) as ThemeName[])];
const FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20] as const;

function ThemePreview({ theme }: { theme: ThemeDefinition }) {
	const color = (key: Parameters<typeof resolveTokenColor>[1]) => resolveTokenColor(theme, key);
	return (
		<span
			aria-hidden
			className="flex h-full w-full overflow-hidden"
			style={{ background: color("--omp-bg-primary") }}
		>
			<span className="h-full w-1/4" style={{ background: color("--omp-sidebar-bg") }} />
			<span className="flex flex-1 flex-col justify-center gap-1.5 px-2">
				<span className="h-1 w-4/5 rounded-(--sc-radius-full)" style={{ background: color("--omp-text") }} />
				<span className="h-1 w-3/5 rounded-(--sc-radius-full)" style={{ background: color("--omp-muted") }} />
				<span className="h-1.5 w-1/3 rounded-(--sc-radius-full)" style={{ background: color("--omp-accent") }} />
			</span>
		</span>
	);
}

/** Inline theme choice: one radio per palette with a live preview; arrow keys move, selection applies at once. */
function ThemeSwatches() {
	const t = useT();
	const [current, setCurrent] = useState<ThemeSelection | null>(null);
	const groupRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		void getPersistedThemeSelection().then(selection => {
			if (!cancelled) setCurrent(selection);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const choose = (selection: ThemeSelection) => {
		applyThemeByName(selection);
		useUiStore.getState().setTheme(selection === "system" ? "system" : THEMES[selection].scheme);
		setCurrent(selection);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (delta === undefined) return;
		event.preventDefault();
		const index = THEME_SELECTIONS.indexOf(current ?? "system");
		const next = THEME_SELECTIONS[(index + delta + THEME_SELECTIONS.length) % THEME_SELECTIONS.length];
		choose(next);
		groupRef.current?.querySelector<HTMLElement>(`[data-theme-option="${next}"]`)?.focus();
	};

	return (
		<div
			aria-label={t("settings.gui.theme")}
			className="settings-theme-grid"
			onKeyDown={onKeyDown}
			ref={groupRef}
			role="radiogroup"
		>
			{THEME_SELECTIONS.map(selection => {
				const selected = selection === (current ?? "system");
				const label = selection === "system" ? t("themePicker.system") : t(`themePicker.theme.${selection}.label`);
				return (
					<button
						aria-checked={selected}
						className="group/theme flex min-w-0 flex-col gap-1.5 rounded-(--sc-radius-lg) p-1 text-left"
						data-theme-option={selection}
						key={selection}
						onClick={() => choose(selection)}
						role="radio"
						tabIndex={selected ? 0 : -1}
						title={
							selection === "system"
								? t("themePicker.systemDesc")
								: t(`themePicker.theme.${selection}.description`)
						}
						type="button"
					>
						<span
							className={cx(
								"relative flex h-14 overflow-hidden rounded-(--sc-radius-md) border",
								selected
									? "border-(--sc-accent) ring-2 ring-(--sc-accent-soft)"
									: "border-(--sc-border-subtle) group-hover/theme:border-(--sc-border)",
							)}
						>
							{selection === "system" ? (
								<>
									<span className="w-1/2 overflow-hidden">
										<ThemePreview theme={THEMES.light} />
									</span>
									<span className="w-1/2 overflow-hidden">
										<ThemePreview theme={THEMES.dark} />
									</span>
								</>
							) : (
								<ThemePreview theme={THEMES[selection]} />
							)}
							{selected && (
								<span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-(--sc-radius-full) bg-(--sc-accent) text-(--sc-accent-fg)">
									<Check aria-hidden className="size-3" strokeWidth={3} />
								</span>
							)}
						</span>
						<span className="flex items-center gap-1 truncate px-0.5 text-sc-sm text-(--sc-text-secondary)">
							{selection === "system" && <Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
							<span className="truncate">{label}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}

/** Each display preference's glyph. */
const DISPLAY_ICONS: Record<(typeof GUI_DISPLAY_BOOL_FIELDS)[number], ReactNode> = {
	hideThinkingBlock: <EyeOff />,
	proseOnlyThinking: <TextQuote />,
	showTokenUsage: <Gauge />,
	collapseCompacted: <Shrink />,
	titleState: <PanelTop />,
	goalStatusInFooter: <Target />,
	showProgress: <Gauge />,
	emojiAutocomplete: <Smile />,
};

/**
 * A display preference that, until changed here, follows the omp setting of
 * the same name; once set in ompdesk a reset returns it to following omp.
 */
export function DisplayPreferenceRow({ field }: { field: (typeof GUI_DISPLAY_BOOL_FIELDS)[number] }) {
	const t = useT();
	const value = useDisplayPreference(field);
	const overridden = useUiStore(state => state.displayPreferences[field] != null);
	const [saving, setSaving] = useState(false);
	const save = async (next: boolean | null) => {
		setSaving(true);
		await setDisplayPreference(field, next);
		setSaving(false);
	};
	return (
		<SettingsSwitchRow
			checked={value}
			description={t(`settings.display.${field}.desc`)}
			disabled={saving}
			extra={
				overridden ? (
					<Button disabled={saving} onClick={() => void save(null)} size="sm" variant="ghost">
						{t("settings.display.inherit")}
					</Button>
				) : undefined
			}
			icon={DISPLAY_ICONS[field]}
			id={`setting-gui-${field}`}
			label={t(`settings.display.${field}`)}
			onCheckedChange={next => void save(next)}
		/>
	);
}

export function AppearanceSection() {
	const t = useT();
	const fontSize = useUiStore(state => state.fontSize);
	const compactDensity = useUiStore(state => state.compactDensity);
	const colorBlindMode = useUiStore(state => state.colorBlindMode);
	const followAgentTheme = useUiStore(state => state.followAgentTheme);
	const thinkingExpanded = useUiStore(state => state.thinkingExpanded);
	const transcriptDetail = useUiStore(state => state.transcriptDetail);
	const pasteMenuThreshold = useDisplayPreference("pasteMenuThreshold");
	const [pasteThresholdDraft, setPasteThresholdDraft] = useState<string | null>(null);
	const [codeLineNumbers, setCodeLineNumbers] = useState(false);
	const fontSizeId = useId();
	const transcriptId = useId();
	const pasteId = useId();

	useEffect(() => {
		let cancelled = false;
		void window.omp.prefs
			.get("codeLineNumbers")
			.then(value => {
				if (!cancelled) setCodeLineNumbers(value === true);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	const applyStorePreference = (key: "compactDensity" | "colorBlindMode" | "followAgentTheme", value: boolean) => {
		void saveGuiPreference(key, value, () => useUiStore.setState({ [key]: value }));
	};

	const commitPasteThreshold = () => {
		if (pasteThresholdDraft === null) return;
		const value = Number(pasteThresholdDraft);
		if (pasteThresholdDraft.trim() === "" || !Number.isInteger(value) || value < 0) {
			toast({ variant: "error", message: t("settings.editors.errNumber") });
			return;
		}
		void setDisplayPreference("pasteMenuThreshold", value).then(ok => {
			if (ok) setPasteThresholdDraft(null);
		});
	};

	return (
		<>
			<SettingsSection title={t("settings.appearance.theme")}>
				<div className="scroll-mt-4 py-2" data-setting-row="true" id="setting-gui-theme">
					<ThemeSwatches />
				</div>
				<SettingsSwitchRow
					checked={followAgentTheme}
					description={t("settings.gui.followAgentThemeDesc")}
					icon={<Palette />}
					id="setting-gui-followAgentTheme"
					label={t("settings.gui.followAgentTheme")}
					onCheckedChange={value => applyStorePreference("followAgentTheme", value)}
				/>
			</SettingsSection>

			<SettingsSection title={t("settings.appearance.text")}>
				<SettingsRow
					control={
						<Select
							id={fontSizeId}
							onChange={event => {
								const next = Number(event.target.value);
								void saveGuiPreference("fontSize", next, () => useUiStore.getState().setFontSize(next));
							}}
							value={String(fontSize)}
						>
							{!FONT_SIZES.some(size => size === fontSize) && (
								<option value={String(fontSize)}>{t("settings.gui.fontSizeOption", { size: fontSize })}</option>
							)}
							{FONT_SIZES.map(size => (
								<option key={size} value={String(size)}>
									{size === 15
										? t("settings.gui.fontSizeDefault", { size })
										: t("settings.gui.fontSizeOption", { size })}
								</option>
							))}
						</Select>
					}
					description={t("settings.gui.fontSizeDesc")}
					htmlFor={fontSizeId}
					icon={<Type />}
					id="setting-gui-fontSize"
					label={t("settings.gui.fontSize")}
				/>
				<SettingsSwitchRow
					checked={compactDensity}
					description={t("settings.gui.compactDensityDesc")}
					icon={<Rows3 />}
					id="setting-gui-compactDensity"
					label={t("settings.gui.compactDensity")}
					onCheckedChange={value => applyStorePreference("compactDensity", value)}
				/>
				<SettingsSwitchRow
					checked={colorBlindMode}
					description={t("settings.gui.colorBlindModeDesc")}
					icon={<Eye />}
					id="setting-gui-colorBlindMode"
					label={t("settings.gui.colorBlindMode")}
					onCheckedChange={value => applyStorePreference("colorBlindMode", value)}
				/>
			</SettingsSection>

			<SettingsSection description={t("settings.display.scope")} title={t("settings.display.title")}>
				<SettingsRow
					control={
						<Select
							id={transcriptId}
							onChange={event => {
								const next = event.target.value as TranscriptDetail;
								void saveGuiPreference("transcriptDetail", next, () =>
									useUiStore.getState().setTranscriptDetail(next),
								);
							}}
							options={[
								{ value: "compact", label: t("settings.gui.transcript.compact") },
								{ value: "full", label: t("settings.gui.transcript.full") },
							]}
							value={transcriptDetail}
						/>
					}
					description={t(
						transcriptDetail === "compact"
							? "settings.gui.transcript.compactDesc"
							: "settings.gui.transcript.fullDesc",
					)}
					htmlFor={transcriptId}
					icon={<ScrollText />}
					id="setting-gui-transcriptDetail"
					label={t("settings.gui.transcriptDetail")}
				/>
				<SettingsSwitchRow
					checked={thinkingExpanded}
					description={t("settings.gui.thinkingExpandedDesc")}
					icon={<Brain />}
					id="setting-gui-thinkingExpanded"
					label={t("settings.gui.thinkingExpanded")}
					onCheckedChange={next =>
						void saveGuiPreference("thinkingExpanded", next, () =>
							useUiStore.getState().setThinkingExpanded(next),
						)
					}
				/>
				<SettingsSwitchRow
					checked={codeLineNumbers}
					description={t("codeblock.lineNumbersDesc")}
					icon={<ListOrdered />}
					id="setting-gui-lineNumbers"
					label={t("codeblock.lineNumbers")}
					onCheckedChange={next =>
						void setCodeLineNumbersPref(next).then(ok => {
							if (ok) setCodeLineNumbers(next);
						})
					}
				/>
				{GUI_DISPLAY_BOOL_FIELDS.filter(
					field => field !== "titleState" && field !== "showProgress" && field !== "emojiAutocomplete",
				).map(field => (
					<DisplayPreferenceRow field={field} key={field} />
				))}
			</SettingsSection>
			<SettingsSection title={t("settings.appearance.input")}>
				<DisplayPreferenceRow field="emojiAutocomplete" />
				<SettingsRow
					control={
						<Input
							id={pasteId}
							min={0}
							onBlur={commitPasteThreshold}
							onChange={event => setPasteThresholdDraft(event.target.value)}
							onKeyDown={event => {
								if (isImeKeyEvent(event)) return;
								if (event.key === "Enter") event.currentTarget.blur();
							}}
							step={1}
							type="number"
							value={pasteThresholdDraft ?? String(pasteMenuThreshold)}
						/>
					}
					description={t("settings.display.pasteMenuThresholdDesc")}
					htmlFor={pasteId}
					icon={<ClipboardPaste />}
					id="setting-gui-pasteMenuThreshold"
					label={t("settings.display.pasteMenuThreshold")}
				/>
			</SettingsSection>
		</>
	);
}
