/**
 * Settings › Agent behavior › Computer use engine: how agents see and operate apps on this computer (pref
 * `computerUse`, src/shared/computer-use.ts). agent-desktop is the default; OMPdesk installs and updates it through
 * machine setup (item `agent-desktop`), so the note under the row follows that item. A session started without the
 * executable runs on the built-in computer use and says so in its transcript; the pick applies from a session's next
 * start, so nothing is pushed to the open ones.
 */

import { Monitor } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	COMPUTER_USE_PREF,
	type ComputerUseEngine,
	isComputerUseEngine,
	parseComputerUseEngine,
} from "../../../shared/computer-use";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { toastError } from "../../stores/toast";
import { Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

export function ComputerUseRow() {
	const t = useT();
	const id = useId();
	const [pref, setPref] = useState<ComputerUseEngine | null>(null);
	const item = useMachineSetupStore(state => state.state?.items.find(entry => entry.id === "agent-desktop"));

	useEffect(() => {
		useMachineSetupStore.getState().ensureLoaded();
		let live = true;
		window.omp.prefs
			.get(COMPUTER_USE_PREF)
			.then(stored => {
				if (live) setPref(parseComputerUseEngine(stored));
			})
			.catch((error: unknown) => {
				if (!live) return;
				setPref(parseComputerUseEngine(undefined));
				toastError({ title: t("settings.gui.computerUseLoadFailed"), error });
			});
		return () => {
			live = false;
		};
	}, [t]);

	// Not shown before detection has answered: "not installed" would flash on a computer that has it.
	const presence = item?.presence;
	const installed = presence?.kind === "present";
	let note: string | null = null;
	if (pref === "agent-desktop" && presence) {
		if (!installed) note = t("settings.gui.computerUseMissing");
		else if (presence.version) note = t("settings.gui.computerUseVersion", { version: presence.version });
		else note = t("settings.gui.computerUseInstalled");
	}

	return (
		<SettingsRow
			control={
				<Select
					disabled={pref === null}
					id={id}
					onChange={event => {
						const next = event.target.value;
						if (isComputerUseEngine(next)) void saveGuiPreference(COMPUTER_USE_PREF, next, () => setPref(next));
					}}
					options={[
						{ value: "agent-desktop", label: t("settings.gui.computerUse.agentDesktop") },
						{ value: "builtin", label: t("settings.gui.computerUse.builtin") },
					]}
					value={pref ?? "agent-desktop"}
				/>
			}
			description={t("settings.gui.computerUseDesc")}
			footer={
				note && (
					<p className="mt-1 text-sc-xs break-keep text-(--sc-text-muted)" data-computer-use-installed={installed}>
						{note}
					</p>
				)
			}
			htmlFor={id}
			icon={<Monitor />}
			id="setting-gui-computerUse"
			label={t("settings.gui.computerUse")}
		/>
	);
}
