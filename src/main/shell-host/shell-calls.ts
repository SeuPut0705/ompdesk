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

/**
 * Why `safeStorage` cannot encrypt, in the shell's words (`KEYCHAIN_WOULD_ASK` when the macOS keychain would have shown
 * a dialog); null while it can. Asking settles the key (the shell reads it once, and a refusal stays for the run).
 */
export function safeStorageUnavailableReason(): string | null {
	const storage = (electron as unknown as { safeStorage: { getUnavailableReason?: () => string | null } }).safeStorage;
	return storage.getUnavailableReason?.() ?? null;
}

/**
 * The folder of the default session's HTTP cache, as the shell keeps it (`<userData>/shell-webview/Default/Cache`); null
 * when it is not told (Electron has no such call: its cache is `<userData>/Cache`).
 */
export function defaultSessionCachePath(): string | null {
	const session = electron.session.defaultSession as unknown as { getCachePath?: () => string | null };
	return session.getCachePath?.() ?? null;
}

/** `clipboard.readText()`. */
export function readClipboardText(): Promise<string> {
	return shim().clipboard.readTextAsync();
}

/** `powerMonitor.getSystemIdleTime()`, in seconds; a failure of any kind is a rejection, never a throw. */
export async function systemIdleSeconds(): Promise<number> {
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
