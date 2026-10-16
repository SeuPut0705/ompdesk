import { useEffect, useState } from "react";
import { AUTO_MODE_PREF, autoModeFromPref } from "../../../resources/gui-bridge/auto-mode-contracts";
import { saveGuiPreference } from "../lib/display-preferences";

/** The automatic mode choice's pref (default on): read when the component mounts, written through main. */
export function useAutoModePref(): [boolean, (next: boolean) => void] {
	const [enabled, setEnabled] = useState(true);
	useEffect(() => {
		let live = true;
		void window.omp.prefs.get(AUTO_MODE_PREF).then(stored => {
			if (live) setEnabled(autoModeFromPref(stored));
		});
		return () => {
			live = false;
		};
	}, []);
	return [enabled, next => void saveGuiPreference(AUTO_MODE_PREF, next, () => setEnabled(next))];
}
