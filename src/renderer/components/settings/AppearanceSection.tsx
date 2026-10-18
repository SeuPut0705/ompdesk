/**
 * Settings › Appearance: theme (inline swatches), text size and density,
 * and how conversations render. Every control applies immediately.
 */

import {
	Brain,
	ClipboardPaste,
	Eye,
	EyeOff,
	Gauge,
	ListOrdered,
	Palette,
	PanelRight,
	PanelTop,
	Rows3,
	ScrollText,
	Shrink,
	Smile,
	Target,
	TextQuote,
	Type,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
	GUI_DISPLAY_BOOL_FIELDS,
	saveGuiPreference,
	setDisplayPreference,
	useDisplayPreference,
} from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { setCodeLineNumbersPref } from "../../lib/markdown";
import { toast } from "../../stores/toast";
import { type TranscriptDetail, useUiStore } from "../../stores/ui";
import { webRuntime } from "../../web/runtime";
import { Button, Input, Select, SettingInfo } from "../common";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";
import { ThemePicker } from "./ThemePicker";

const FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20] as const;

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

/**
 * A paired web device keeps everything on this page for itself (shared/device-prefs.ts): the shim stores it in
 * the device's own record on the host, so the computer's look and this device's never move each other.
 */
function ThisDeviceNote() {
	const t = useT();
	if (!webRuntime()) return null;
	return (
		<p
			className="mb-3 flex items-center gap-2 text-sc-xs break-keep text-(--sc-text-muted)"
			data-device-prefs-note="true"
		>
			<span className="rounded-full bg-(--sc-accent-soft) px-2 py-0.5 font-medium text-(--sc-text)">
				{t("settings.appearance.thisDevice")}
			</span>
			<span className="min-w-0 truncate">{t("settings.appearance.thisDeviceShort")}</span>
			<SettingInfo text={t("settings.appearance.thisDeviceNote")} />
		</p>
	);
}

export function AppearanceSection() {
	const t = useT();
	const fontSize = useUiStore(state => state.fontSize);
	const compactDensity = useUiStore(state => state.compactDensity);
	const colorBlindMode = useUiStore(state => state.colorBlindMode);
	const followAgentTheme = useUiStore(state => state.followAgentTheme);
	const thinkingExpanded = useUiStore(state => state.thinkingExpanded);
	const workBoard = useUiStore(state => state.workBoard);
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
			<ThisDeviceNote />
			<SettingsSection title={t("settings.appearance.theme")}>
				<ThemePicker />
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
					checked={workBoard}
					description={t("settings.gui.workBoardDesc")}
					icon={<PanelRight />}
					id="setting-gui-workBoard"
					label={t("settings.gui.workBoard")}
					onCheckedChange={next =>
						void saveGuiPreference("workBoard", next, () => useUiStore.getState().setWorkBoard(next))
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
