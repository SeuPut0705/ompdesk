import { useEffect, useRef } from "react";
import { create } from "zustand";
import { isUiLanguage } from "../../shared/ui-language";
import { saveGuiPreference } from "../lib/display-preferences";
import { setLanguageOverride } from "../lib/i18n";
import {
	applyThemeByName,
	getPersistedThemeSelection,
	isThemeSelection,
	resolveThemeSelection,
	type ThemeSelection,
} from "../lib/themes";
import { useFocusedHost } from "../stores/remote";
import { useUiStore } from "../stores/ui";

/** prefs key of Settings › Devices & connections › "Use the host computer's theme and language" (B16). */
export const HOST_APPEARANCE_PREF = "useHostAppearance";

interface HostAppearanceStore {
	enabled: boolean;
	loaded: boolean;
	load(): Promise<void>;
	setEnabled(next: boolean): Promise<void>;
}

export const useHostAppearanceStore = create<HostAppearanceStore>()(set => ({
	enabled: false,
	loaded: false,
	async load() {
		const stored = await window.omp.prefs.get(HOST_APPEARANCE_PREF).catch(() => undefined);
		set({ enabled: stored === true, loaded: true });
	},
	async setEnabled(next) {
		await saveGuiPreference(HOST_APPEARANCE_PREF, next, () => set({ enabled: next }));
	},
}));

/** Show a theme selection without saving it, keeping `ui.theme` (the OS-theme watcher's input) in step. */
function showTheme(selection: ThemeSelection): void {
	applyThemeByName(selection, { persist: false });
	useUiStore.setState({ theme: selection === "system" ? "system" : resolveThemeSelection(selection).scheme });
}

/**
 * B16: while the switch is on and the focused tab runs on an online paired
 * host, show that host's theme and UI language (`hostDesktop.get(device)`)
 * without saving either; focusing a tab on this computer, the host going
 * offline or turning the switch off brings this computer's own back. A host
 * value this build does not know (an unknown theme or language) keeps the
 * user's own for that part. Mounted once, by App.
 */
export function useHostAppearance(): void {
	const enabled = useHostAppearanceStore(state => state.enabled);
	const host = useFocusedHost();
	const deviceId = enabled && host?.online ? host.deviceId : undefined;
	/** Whether a host's appearance is showing, so leaving it restores the user's own exactly once. */
	const showingHost = useRef(false);

	useEffect(() => {
		void useHostAppearanceStore.getState().load();
	}, []);

	useEffect(() => {
		let live = true;
		const restoreOwn = async () => {
			if (!showingHost.current) return;
			showingHost.current = false;
			setLanguageOverride(null);
			const own = await getPersistedThemeSelection();
			// A host focused again meanwhile owns the theme now.
			if (!showingHost.current) showTheme(own);
		};
		if (!deviceId) {
			void restoreOwn();
			return;
		}
		void window.omp.hostDesktop
			.get(deviceId)
			.then(async ({ appearance }) => {
				if (!live) return;
				const { themeName, language } = appearance;
				const theme = isThemeSelection(themeName) ? themeName : await getPersistedThemeSelection();
				if (!live) return;
				showingHost.current = true;
				setLanguageOverride(isUiLanguage(language) ? language : null);
				showTheme(theme);
			})
			// An unreachable or older host leaves this computer's own appearance.
			.catch(() => {
				if (live) void restoreOwn();
			});
		return () => {
			live = false;
		};
	}, [deviceId]);
}
