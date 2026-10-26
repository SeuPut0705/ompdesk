/**
 * Settings › Agent behavior › Default browser: which browser agents use (prefs `defaultBrowser`,
 * src/shared/default-browser.ts). Main resolves it against whether ego-browser is installed and pushes a change to
 * every open local session, effective from its next turn. The row says so when the choice needs ego-browser and
 * it is not installed.
 */

import { Globe } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	DEFAULT_BROWSER_PREF,
	type DefaultBrowserPref,
	isDefaultBrowserPref,
	parseDefaultBrowser,
} from "../../../shared/default-browser";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

export function DefaultBrowserRow() {
	const t = useT();
	const id = useId();
	const [pref, setPref] = useState<DefaultBrowserPref | null>(null);
	const [egoInstalled, setEgoInstalled] = useState<boolean | null>(null);

	useEffect(() => {
		let live = true;
		window.omp.prefs
			.get(DEFAULT_BROWSER_PREF)
			.then(stored => {
				if (live) setPref(parseDefaultBrowser(stored));
			})
			.catch((error: unknown) => {
				if (!live) return;
				setPref("auto");
				toastError({ title: t("settings.gui.defaultBrowserLoadFailed"), error });
			});
		window.omp.prefs
			.defaultBrowserStatus()
			.then(status => {
				if (live) setEgoInstalled(status.egoInstalled);
			})
			// The note just stays off.
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [t]);

	return (
		<SettingsRow
			control={
				<Select
					disabled={pref === null}
					id={id}
					onChange={event => {
						const next = event.target.value;
						if (isDefaultBrowserPref(next))
							void saveGuiPreference(DEFAULT_BROWSER_PREF, next, () => setPref(next));
					}}
					options={[
						{
							value: "auto",
							// What automatic picks on this computer, once known.
							label:
								egoInstalled === null
									? t("settings.gui.defaultBrowser.auto")
									: t("settings.gui.defaultBrowser.autoResolved", {
											browser: t(`settings.gui.defaultBrowser.${egoInstalled ? "ego" : "builtin"}`),
										}),
						},
						{ value: "ego", label: t("settings.gui.defaultBrowser.ego") },
						{ value: "builtin", label: t("settings.gui.defaultBrowser.builtin") },
					]}
					value={pref ?? "auto"}
				/>
			}
			description={t("settings.gui.defaultBrowserDesc")}
			footer={
				pref !== null &&
				pref !== "builtin" &&
				egoInstalled === false && (
					<p className="mt-1 text-sc-xs break-keep text-(--sc-text-muted)" data-default-browser-missing="true">
						{t("settings.gui.defaultBrowserMissing")}
					</p>
				)
			}
			htmlFor={id}
			icon={<Globe />}
			id="setting-gui-defaultBrowser"
			label={t("settings.gui.defaultBrowser")}
		/>
	);
}
