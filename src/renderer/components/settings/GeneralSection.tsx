/**
 * Settings › General: language, conversation language, notifications, side
 * panel default (this device's app preferences), then messages sent mid-turn
 * and long-session compaction (the focused tab's agent — a paired host's own).
 */

import { useId } from "react";
import { isUiLanguage, UI_LANGUAGE_NAMES, UI_LANGUAGES } from "../../../shared/ui-language";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useLang, useT } from "../../lib/i18n";
import { type PanelTab, useUiStore } from "../../stores/ui";
import { Select } from "../common";
import { DisplayPreferenceRow } from "./AppearanceSection";
import { ProxyRow } from "./LaunchSettings";
import { ReplyLanguageRow } from "./ReplyLanguageRow";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";

const PANEL_DEFAULTS: readonly PanelTab[] = ["diff", "files", "logs"];

export function GeneralSection() {
	const t = useT();
	const { lang, setLang } = useLang();
	const notifications = useUiStore(state => state.notifications);
	const panelTab = useUiStore(state => state.panelTab);
	const languageId = useId();
	const panelId = useId();
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
				<SettingsSwitchRow
					checked={notifications}
					description={t("settings.gui.notificationsDesc")}
					id="setting-gui-notifications"
					label={t("settings.gui.notifications")}
					onCheckedChange={next =>
						void saveGuiPreference("notifications", next, () => useUiStore.getState().setNotifications(next))
					}
				/>
			</SettingsSection>
			<SettingsSection title={t("settings.general.window")}>
				<SettingsRow
					control={
						<Select
							id={panelId}
							onChange={event => {
								const next = event.target.value as PanelTab;
								void saveGuiPreference("defaultPanelTab", next, () => useUiStore.getState().setPanelTab(next));
							}}
							options={PANEL_DEFAULTS.map(value => ({ value, label: t(`settings.gui.panel.${value}`) }))}
							value={PANEL_DEFAULTS.includes(panelTab) ? panelTab : "diff"}
						/>
					}
					description={t("settings.gui.panelDefaultDesc")}
					htmlFor={panelId}
					id="setting-gui-panelDefault"
					label={t("settings.gui.panelDefault")}
				/>
				<DisplayPreferenceRow field="titleState" />
				<DisplayPreferenceRow field="showProgress" />
				<ProxyRow />
			</SettingsSection>
		</>
	);
}
