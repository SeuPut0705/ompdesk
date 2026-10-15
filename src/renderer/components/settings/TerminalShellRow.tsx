/**
 * Settings › General › Terminal shell (C104): the shell new Terminal panel
 * tabs start with. Lists the shells main detected (main/terminal/shells.ts);
 * "Default" leaves it to this computer's login shell (Command Prompt on Windows).
 */
import { useEffect, useId, useState } from "react";
import { TERMINAL_SHELL_PREF, type TerminalShell } from "../../../shared/terminal-types";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

export function TerminalShellRow() {
	const t = useT();
	const id = useId();
	const [shells, setShells] = useState<TerminalShell[] | null>(null);
	const [value, setValue] = useState("");
	useEffect(() => {
		let live = true;
		// Started inside a promise so a missing API (a paired host's settings, tests) lands in the failure branch.
		void Promise.resolve()
			.then(() => Promise.all([window.omp.terminal.shells(), window.omp.prefs.get(TERMINAL_SHELL_PREF)]))
			.then(
				([found, stored]) => {
					if (!live) return;
					setShells(found);
					setValue(typeof stored === "string" && found.some(shell => shell.path === stored) ? stored : "");
				},
				() => {
					if (live) setShells([]);
				},
			);
		return () => {
			live = false;
		};
	}, []);
	return (
		<SettingsRow
			control={
				<Select
					disabled={!shells || shells.length < 2}
					id={id}
					onChange={event => {
						const next = event.target.value;
						void saveGuiPreference(TERMINAL_SHELL_PREF, next, () => setValue(next));
					}}
					options={[
						{ value: "", label: t("settings.gui.terminalShellDefault") },
						...(shells ?? []).map(shell => ({ value: shell.path, label: `${shell.name} · ${shell.path}` })),
					]}
					value={value}
				/>
			}
			description={t("settings.gui.terminalShellDesc")}
			htmlFor={id}
			id="setting-gui-terminalShell"
			label={t("settings.gui.terminalShell")}
		/>
	);
}
