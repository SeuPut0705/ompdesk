/**
 * How omp spreads a provider's sessions over its stored OAuth accounts
 * (Settings › Models & providers; prefs `accountRotation`, per machine).
 *
 * - `quota` (default): stock omp's usage ranking — the account whose window
 *   resets first is drained first, blocked or nearly exhausted ones wait.
 * - `even`: new sessions take the accounts in turn; blocked accounts are
 *   skipped until their reset and a 429 still fails over.
 *
 * Main passes the mode to omp as `OMP_GUI_ACCOUNT_ROTATION` at spawn and
 * through the bridge's `account_rotation_set` on change and on connect; the
 * gui-bridge (resources/gui-bridge/account-rotation.ts) applies even mode. A
 * paired host's tabs follow the host's own pref.
 */

/** prefs key (electron-store `prefs`). */
export const ACCOUNT_ROTATION_PREF = "accountRotation";

export const ACCOUNT_ROTATION_MODES = ["quota", "even"] as const;

export type AccountRotationMode = (typeof ACCOUNT_ROTATION_MODES)[number];

export function isAccountRotationMode(value: unknown): value is AccountRotationMode {
	return value === "quota" || value === "even";
}

/** A stored pref; missing or unknown (hand-edited, a later version's choice) reads as `quota`. */
export function parseAccountRotationPref(value: unknown): AccountRotationMode {
	return isAccountRotationMode(value) ? value : "quota";
}

/** One machine's setting as Settings shows it. */
export interface AccountRotationState {
	mode: AccountRotationMode;
	/**
	 * Whether that machine's omp can do even rotation (the gui-bridge
	 * `accountRotation` feature); null until one of its sessions has connected.
	 */
	evenSupported: boolean | null;
}

/** File (in userData) where every local omp's bridge records whose turn it is under even rotation. */
export const ACCOUNT_ROTATION_LEDGER_FILE = "account-rotation.json";
