/** Prefs key set before the macOS prompts are shown, so a person who declines them is never asked again. */
export const MAC_PERMISSIONS_ASKED_PREF = "macPermissionsAsked";

export interface MacPermissionDeps {
	platform: NodeJS.Platform;
	/** Only a packaged, non-headless app asks: a dev or test launch must never raise a system prompt. */
	automatic: boolean;
	prefs: { get(key: string): unknown; set(key: string, value: unknown): void };
	/** `systemPreferences.isTrustedAccessibilityClient(prompt)`. */
	accessibilityTrusted(prompt: boolean): boolean;
	/** `systemPreferences.getMediaAccessStatus("screen")`. */
	screenStatus(): string;
	/** A screen capture request, which is what makes macOS show the Screen Recording prompt. */
	requestScreenCapture(): Promise<void>;
}

/**
 * Accessibility and Screen Recording cannot be granted by an app, only by the person in System Settings. Computer
 * use (the `computer` eval prelude) runs inside omp, which macOS attributes to OMPdesk, so OMPdesk asks the OS once
 * on the first launch after agents got every power by default: the system prompt reaches the person without a hunt
 * through Settings. Remembered before the prompts show; a declined or ignored prompt is never repeated.
 * Returns whether it asked.
 */
export async function askMacPermissionsOnce(deps: MacPermissionDeps): Promise<boolean> {
	if (deps.platform !== "darwin" || !deps.automatic) return false;
	if (deps.prefs.get(MAC_PERMISSIONS_ASKED_PREF) === true) return false;
	deps.prefs.set(MAC_PERMISSIONS_ASKED_PREF, true);
	deps.accessibilityTrusted(true);
	if (deps.screenStatus() === "not-determined") await deps.requestScreenCapture();
	return true;
}
