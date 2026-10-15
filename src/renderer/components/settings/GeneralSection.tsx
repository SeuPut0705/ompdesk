/**
 * Settings › General: language, conversation language, notifications (and
 * their chime), how reply links open, the profile the agent addresses (name,
 * development experience), side panel default and edge, window close and
 * sleep behaviour (this device's app preferences), then messages sent
 * mid-turn and long-session compaction (the focused tab's agent — a paired
 * host's own), then the tools OMPdesk sets up on this computer.
 */

import { Play } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { CLOSE_TO_TRAY_PREF, KEEP_AWAKE_WORKING_PREF } from "../../../shared/desktop-prefs";
import { isUiLanguage, UI_LANGUAGE_NAMES, UI_LANGUAGES } from "../../../shared/ui-language";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useLang, useT } from "../../lib/i18n";
import { PLATFORM } from "../../lib/keymap";
import { playChime } from "../../lib/notification-sound";
import { PANEL_TABS, type PanelSide, type PanelTab, useUiStore } from "../../stores/ui";
import { Button, Select } from "../common";
import { DisplayPreferenceRow } from "./AppearanceSection";
import { GithubAccountSection } from "./GithubAccountSection";
import { ProxyRow } from "./LaunchSettings";
import { MachineSetupSection } from "./MachineSetupSection";
import { OutputStyleRow } from "./OutputStyleRow";
import { ProfileSection } from "./ProfileSection";
import { ReplyLanguageRow } from "./ReplyLanguageRow";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";
import { TerminalShellRow } from "./TerminalShellRow";

const PANEL_SIDES: readonly PanelSide[] = ["right", "left"];

/** A boolean preference main reads (close to tray, keep awake); false until it loads. */
function useMainPreference(key: string): [boolean, (next: boolean) => void] {
	const [value, setValue] = useState(false);
	useEffect(() => {
		let live = true;
		void window.omp.prefs.get(key).then(stored => {
			if (live) setValue(stored === true);
		});
		return () => {
			live = false;
		};
	}, [key]);
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
	const [closeToTray, setCloseToTray] = useMainPreference(CLOSE_TO_TRAY_PREF);
	const [keepAwake, setKeepAwake] = useMainPreference(KEEP_AWAKE_WORKING_PREF);
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
					id="setting-gui-language"
					label={t("settings.gui.language")}
				/>
				<ReplyLanguageRow />
				<OutputStyleRow />
				<SettingsSwitchRow
					checked={notifications}
					description={t("settings.gui.notificationsDesc")}
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
						id="setting-gui-notificationVolume"
						label={t("settings.gui.notificationVolume")}
					/>
				)}
				<SettingsSwitchRow
					checked={linkPreview}
					description={t("settings.gui.linkPreviewDesc")}
					id="setting-gui-linkPreview"
					label={t("settings.gui.linkPreview")}
					onCheckedChange={next =>
						void saveGuiPreference("linkPreview", next, () => useUiStore.setState({ linkPreview: next }))
					}
				/>
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
							value={panelTab}
						/>
					}
					description={t("settings.gui.panelDefaultDesc")}
					htmlFor={panelId}
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
					id="setting-gui-panelSide"
					label={t("settings.gui.panelSide")}
				/>
				<TerminalShellRow />
				{PLATFORM === "windows" && (
					<SettingsSwitchRow
						checked={closeToTray}
						description={t("settings.gui.closeToTrayDesc")}
						id="setting-gui-closeToTray"
						label={t("settings.gui.closeToTray")}
						onCheckedChange={setCloseToTray}
					/>
				)}
				<SettingsSwitchRow
					checked={keepAwake}
					description={t("settings.gui.keepAwakeWorkingDesc")}
					id="setting-gui-keepAwakeWorking"
					label={t("settings.gui.keepAwakeWorking")}
					onCheckedChange={setKeepAwake}
				/>
				<DisplayPreferenceRow field="titleState" />
				<DisplayPreferenceRow field="showProgress" />
				<ProxyRow />
			</SettingsSection>
			<MachineSetupSection />
			<GithubAccountSection />
		</>
	);
}
