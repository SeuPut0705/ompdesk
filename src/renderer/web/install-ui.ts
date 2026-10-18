/**
 * What the install entry points (the help menu item, Settings › Mobile web, the second-visit hint) share: the
 * current guidance as a hook, and the action — the browser's own dialog where it has one, otherwise the sheet
 * with the menu steps.
 */
import { useSyncExternalStore } from "react";
import { useHostUiStore } from "./host-ui/host-ui-store";
import { type InstallGuidance, installOffered, installStepKeys } from "./install";
import { type WebPwa, webPwa } from "./pwa";

/** What to offer for installing, kept current as the browser fires `beforeinstallprompt` or `appinstalled`. */
export function useInstallGuidance(pwa: WebPwa | null = webPwa()): InstallGuidance {
	return useSyncExternalStore(
		listener => pwa?.install.onChange(listener) ?? (() => {}),
		() => pwa?.guidance() ?? "none",
		() => "none",
	);
}

/** Whether an "Install app" entry belongs in the UI right now (hidden when installed or nothing to offer). */
export function useInstallOffered(): boolean {
	return installOffered(useInstallGuidance());
}

/** Starts the install: the browser's dialog (it can be used once) or the sheet with the steps. */
export function startInstall(): void {
	const pwa = webPwa();
	if (!pwa) return;
	const guidance = pwa.guidance();
	if (guidance === "prompt") void pwa.install.install();
	else if (installStepKeys(guidance).length > 0) useHostUiStore.getState().push({ kind: "install", guidance });
}
