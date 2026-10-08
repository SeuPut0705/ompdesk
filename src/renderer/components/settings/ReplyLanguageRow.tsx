/**
 * Settings › General › Conversation language: which language the agent
 * replies in (prefs `replyLanguage`, src/shared/reply-language.ts). Main pushes
 * a change to every open local session, effective from its next turn. A tab
 * on a paired host follows the host's own setting, and the row says so.
 */

import { useEffect, useId, useState } from "react";
import {
	isReplyLanguagePref,
	parseReplyLanguagePref,
	REPLY_LANGUAGE_CHOICES,
	REPLY_LANGUAGE_PREF,
	type ReplyLanguageChoice,
	type ReplyLanguagePref,
} from "../../../shared/reply-language";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useLang, useT } from "../../lib/i18n";
import { useFocusedHost } from "../../stores/remote";
import { toastError } from "../../stores/toast";
import { Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

/** Locale key suffix per curated choice (`settings.gui.replyLanguage.<suffix>`). */
const CHOICE_KEYS: Record<ReplyLanguageChoice, string> = {
	Korean: "korean",
	English: "english",
	Japanese: "japanese",
	"Chinese (Simplified)": "chineseSimplified",
	"Chinese (Traditional)": "chineseTraditional",
	Spanish: "spanish",
	French: "french",
	German: "german",
	Portuguese: "portuguese",
	Vietnamese: "vietnamese",
};

/** The device language's name in the UI language; the subtag itself when the engine has none. */
function deviceLanguageLabel(tag: string, lang: string): string {
	try {
		return new Intl.DisplayNames([lang], { type: "language" }).of(tag) ?? tag;
	} catch {
		return tag;
	}
}

export function ReplyLanguageRow() {
	const t = useT();
	const { lang } = useLang();
	const id = useId();
	const host = useFocusedHost();
	const [pref, setPref] = useState<ReplyLanguagePref | null>(null);
	const [deviceTag, setDeviceTag] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		window.omp.prefs
			.get(REPLY_LANGUAGE_PREF)
			.then(stored => {
				if (live) setPref(parseReplyLanguagePref(stored));
			})
			.catch((error: unknown) => {
				if (!live) return;
				setPref("auto");
				toastError({ title: t("settings.gui.replyLanguageLoadFailed"), error });
			});
		window.omp.system
			.info()
			.then(info => {
				if (live) setDeviceTag(info.deviceLanguage);
			})
			// The description just leaves the detected name out.
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [t]);

	const device = deviceTag ? deviceLanguageLabel(deviceTag, lang) : null;
	const description =
		pref === "off"
			? t("settings.gui.replyLanguageDescOff")
			: pref === "auto" && device
				? t("settings.gui.replyLanguageDescAuto", { language: device })
				: t("settings.gui.replyLanguageDesc");

	return (
		<SettingsRow
			control={
				<Select
					disabled={pref === null}
					id={id}
					onChange={event => {
						const next = event.target.value;
						if (isReplyLanguagePref(next)) void saveGuiPreference(REPLY_LANGUAGE_PREF, next, () => setPref(next));
					}}
					options={[
						{ value: "auto", label: t("settings.gui.replyLanguage.auto") },
						...REPLY_LANGUAGE_CHOICES.map(value => ({
							value,
							label: t(`settings.gui.replyLanguage.${CHOICE_KEYS[value]}`),
						})),
						{ value: "off", label: t("settings.gui.replyLanguage.off") },
					]}
					value={pref ?? "auto"}
				/>
			}
			description={description}
			footer={
				host && (
					<p className="mt-1 text-sc-xs break-keep text-(--sc-text-muted)" data-reply-language-host="true">
						{t("settings.gui.replyLanguageHost", { name: host.name ?? t("remote.tab.unknownDevice") })}
					</p>
				)
			}
			htmlFor={id}
			id="setting-gui-replyLanguage"
			label={t("settings.gui.replyLanguage")}
		/>
	);
}
