/**
 * The few Electron calls that are synchronous there and cannot be under the shell (it answers them from a process
 * of its own): each has an asynchronous form on the `electron` shim, and main calls these instead of the original.
 * What each one changed is in INVENTORY.md.
 */
import * as electron from "electron";

interface AsyncForms {
	clipboard: { readTextAsync(): Promise<string> };
	powerMonitor: { getSystemIdleTimeAsync(): Promise<number> };
	systemPreferences: {
		isTrustedAccessibilityClientAsync(prompt: boolean): Promise<boolean>;
		getMediaAccessStatusAsync(mediaType: string): Promise<string>;
	};
}

// The shim's asynchronous forms are not in Electron's own typings: one named view of them, read when a call is made
// (a test that replaces `electron` without them must still load this module).
const shim = (): AsyncForms => electron as unknown as AsyncForms;

/** `clipboard.readText()`. */
export function readClipboardText(): Promise<string> {
	return shim().clipboard.readTextAsync();
}

/** `powerMonitor.getSystemIdleTime()`, in seconds. */
export function systemIdleSeconds(): Promise<number> {
	return shim().powerMonitor.getSystemIdleTimeAsync();
}

/** `systemPreferences.isTrustedAccessibilityClient(prompt)` (macOS). */
export function accessibilityTrusted(prompt: boolean): Promise<boolean> {
	return shim().systemPreferences.isTrustedAccessibilityClientAsync(prompt);
}

/** `systemPreferences.getMediaAccessStatus("screen") === "granted"` (macOS). */
export async function screenRecordingGranted(): Promise<boolean> {
	return (await shim().systemPreferences.getMediaAccessStatusAsync("screen")) === "granted";
}
