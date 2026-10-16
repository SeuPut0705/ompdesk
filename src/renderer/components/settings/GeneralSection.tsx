/**
 * Settings › General: language, conversation language and reply style;
 * notifications (and their chime); the profile the agent addresses (name,
 * development experience); the window (side panel default and edge, terminal
 * shell, how reply links open, window close, sleep, title and Dock status);
 * the sidebar's pinned shortcuts; the GitHub account; and, folded under
 * Advanced, this device's network proxy. All of it is this device's.
 */

import {
	Bell,
	Coffee,
	ExternalLink,
	Languages,
	LayoutPanelLeft,
	PanelRight,
	Play,
	Power,
	RotateCcw,
	Volume2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { CLOSE_TO_TRAY_PREF, KEEP_AWAKE_WORKING_PREF, RESUME_INTERRUPTED_PREF } from "../../../shared/desktop-prefs";
import { isUiLanguage, UI_LANGUAGE_NAMES, UI_LANGUAGES } from "../../../shared/ui-language";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useLang, useT } from "../../lib/i18n";
import { PLATFORM } from "../../lib/keymap";
import { playChime } from "../../lib/notification-sound";
import { RAIL_PIN_LABEL_KEYS, RAIL_PINS, useSidebarPrefs } from "../../stores/sidebar-prefs";
import { migrateDefaultPanelTab, PANEL_TABS, type PanelSide, type PanelTab, useUiStore } from "../../stores/ui";
import { Button, Select } from "../common";
import { DisplayPreferenceRow } from "./AppearanceSection";
import { GithubAccountSection } from "./GithubAccountSection";
import { ProxyRow } from "./LaunchSettings";
import { OutputStyleRow } from "./OutputStyleRow";
import { ProfileSection } from "./ProfileSection";
import { ReplyLanguageRow } from "./ReplyLanguageRow";
import { SettingsAdvanced, SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";
import { TerminalShellRow } from "./TerminalShellRow";

const PANEL_SIDES: readonly PanelSide[] = ["right", "left"];

/** A boolean preference main reads (close to tray, keep awake, worktree auto-clean); `fallback` until it loads or while it was never set. */
export function useMainPreference(key: string, fallback = false): [boolean, (next: boolean) => void] {
	const [value, setValue] = useState(fallback);
	useEffect(() => {
		let live = true;
		void window.omp.prefs.get(key).then(stored => {
			if (live) setValue(typeof stored === "boolean" ? stored : fallback);
		});
		return () => {
			live = false;
		};
	}, [key, fallback]);
	return [value, next => void saveGuiPreference(key, next, () => setValue(next))];
}

export function GeneralSection() {
	const t = useT();
	const { lang, setLang } = useLang();
	const notifications = useUiStore(state => state.notifications);
	const notificationSound = useUiStore(state => state.notificationSound);
	const notificationVolume = useUiStore(state => state.notificationVolume);
	const linkPreview = useUiStore(state => state.linkPreview);
	const panelTab = useUiStore(state => state.panelTab);
	const panelSide = useUiStore(state => state.panelSide);
	const [closeToTray, setCloseToTray] = useMainPreference(CLOSE_TO_TRAY_PREF, true);
	const [keepAwake, setKeepAwake] = useMainPreference(KEEP_AWAKE_WORKING_PREF);
	const [resumeInterrupted, setResumeInterrupted] = useMainPreference(RESUME_INTERRUPTED_PREF, true);
	const languageId = useId();
	const panelId = useId();
	const panelSideId = useId();
	const volumeId = useId();
	return (
		<>
			<SettingsSection title={t("settings.general.language")}>
				<SettingsRow
					control={
						<Select
							id={languageId}
							onChange={event => {
								if (isUiLanguage(event.target.value)) setLang(event.target.value);
							}}
							options={UI_LANGUAGES.map(value => ({ value, label: UI_LANGUAGE_NAMES[value] }))}
							value={lang}
						/>
					}
					description={t("settings.gui.languageDesc")}
					htmlFor={languageId}
					icon={<Languages />}
					id="setting-gui-language"
					label={t("settings.gui.language")}
				/>
				<ReplyLanguageRow />
				<OutputStyleRow />
			</SettingsSection>
			<SettingsSection title={t("settings.general.notifications")}>
				<SettingsSwitchRow
					checked={notifications}
					description={t("settings.gui.notificationsDesc")}
					icon={<Bell />}
					id="setting-gui-notifications"
					label={t("settings.gui.notifications")}
					onCheckedChange={next =>
						void saveGuiPreference("notifications", next, () => useUiStore.getState().setNotifications(next))
					}
				/>
				<SettingsSwitchRow
					checked={notificationSound}
					description={t("settings.gui.notificationSoundDesc")}
					extra={
						<Button icon={<Play />} onClick={() => playChime(notificationVolume)} size="sm" variant="ghost">
							{t("settings.gui.notificationSoundTest")}
						</Button>
					}
					icon={<Volume2 />}
					id="setting-gui-notificationSound"
					label={t("settings.gui.notificationSound")}
					onCheckedChange={next =>
						void saveGuiPreference("notificationSound", next, () =>
							useUiStore.setState({ notificationSound: next }),
						)
					}
				/>
				{notificationSound && (
					<SettingsRow
						control={
							<span className="flex items-center gap-2">
								<input
									className="w-36 accent-(--sc-accent)"
									id={volumeId}
									max={100}
									min={0}
									onChange={event => {
										// The slider follows the pointer; the stored value catches up.
										const next = Number(event.target.value);
										useUiStore.setState({ notificationVolume: next });
										void saveGuiPreference("notificationVolume", next, () => {});
									}}
									// Letting go of the slider plays the chime at the new volume.
									onPointerUp={event => playChime(Number(event.currentTarget.value))}
									step={5}
									type="range"
									value={notificationVolume}
								/>
								<span className="w-9 text-right text-sc-sm text-(--sc-text-muted) tabular-nums">
									{notificationVolume}%
								</span>
							</span>
						}
						description={t("settings.gui.notificationVolumeDesc")}
						htmlFor={volumeId}
						icon={<Volume2 />}
						id="setting-gui-notificationVolume"
						label={t("settings.gui.notificationVolume")}
					/>
				)}
			</SettingsSection>
			<ProfileSection />
			<SettingsSection title={t("settings.general.window")}>
				<SettingsRow
					control={
						<Select
							id={panelId}
							onChange={event => {
								const next = event.target.value as PanelTab;
								void saveGuiPreference("defaultPanelTab", next, () => useUiStore.getState().setPanelTab(next));
							}}
							options={PANEL_TABS.map(value => ({ value, label: t(`panel.tabs.${value}`) }))}
							value={migrateDefaultPanelTab(panelTab)}
						/>
					}
					description={t("settings.gui.panelDefaultDesc")}
					htmlFor={panelId}
					icon={<LayoutPanelLeft />}
					id="setting-gui-panelDefault"
					label={t("settings.gui.panelDefault")}
				/>
				<SettingsRow
					control={
						<Select
							id={panelSideId}
							onChange={event => {
								const next = event.target.value === "left" ? "left" : "right";
								void saveGuiPreference("panelSide", next, () => useUiStore.setState({ panelSide: next }));
							}}
							options={PANEL_SIDES.map(value => ({ value, label: t(`settings.gui.panelSide.${value}`) }))}
							value={panelSide}
						/>
					}
					description={t("settings.gui.panelSideDesc")}
					htmlFor={panelSideId}
					icon={<PanelRight />}
					id="setting-gui-panelSide"
					label={t("settings.gui.panelSide")}
				/>
				<TerminalShellRow />
				<SettingsSwitchRow
					checked={linkPreview}
					description={t("settings.gui.linkPreviewDesc")}
					icon={<ExternalLink />}
					id="setting-gui-linkPreview"
					label={t("settings.gui.linkPreview")}
					onCheckedChange={next =>
						void saveGuiPreference("linkPreview", next, () => useUiStore.setState({ linkPreview: next }))
					}
				/>
				{PLATFORM === "windows" && (
					<SettingsSwitchRow
						checked={closeToTray}
						description={t("settings.gui.closeToTrayDesc")}
						icon={<Power />}
						id="setting-gui-closeToTray"
						label={t("settings.gui.closeToTray")}
						onCheckedChange={setCloseToTray}
					/>
				)}
				{PLATFORM === "mac" && (
					<SettingsRow
						description={t("settings.gui.closeToDockDesc")}
						icon={<Power />}
						id="setting-gui-closeToDock"
						label={t("settings.gui.closeToDock")}
					/>
				)}
				<SettingsSwitchRow
					checked={keepAwake}
					description={t("settings.gui.keepAwakeWorkingDesc")}
					icon={<Coffee />}
					id="setting-gui-keepAwakeWorking"
					label={t("settings.gui.keepAwakeWorking")}
					onCheckedChange={setKeepAwake}
				/>
				<SettingsSwitchRow
					checked={resumeInterrupted}
					description={t("settings.gui.resumeInterruptedDesc")}
					icon={<RotateCcw />}
					id="setting-gui-resumeInterrupted"
					label={t("settings.gui.resumeInterrupted")}
					onCheckedChange={setResumeInterrupted}
				/>
				<DisplayPreferenceRow field="titleState" />
				<DisplayPreferenceRow field="showProgress" />
			</SettingsSection>
			<SidebarShortcutsSection />
			<GithubAccountSection />
			<SettingsAdvanced>
				<SettingsSection title={t("settings.general.network")}>
					<ProxyRow />
				</SettingsSection>
			</SettingsAdvanced>
		</>
	);
}

/** Shortcuts pinned above Agents · Stats · Settings at the sidebar's foot; none until the user picks one. */
function SidebarShortcutsSection() {
	const t = useT();
	const railPins = useSidebarPrefs(state => state.railPins);
	return (
		<SettingsSection
			description={t("settings.gui.railPinsDesc")}
			id="setting-gui-railPins"
			title={t("settings.gui.railPins")}
		>
			{RAIL_PINS.map(pin => (
				<SettingsSwitchRow
					checked={railPins.includes(pin)}
					id={`setting-gui-railPin-${pin}`}
					key={pin}
					label={t(RAIL_PIN_LABEL_KEYS[pin])}
					onCheckedChange={() => void useSidebarPrefs.getState().toggleRailPin(pin)}
				/>
			))}
		</SettingsSection>
	);
}
