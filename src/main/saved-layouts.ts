/**
 * When the saved desktop session (prefs `tabLayouts`) is rewritten. Electron-free so the rule is unit-tested
 * (`index.ts` `persistTabLayouts` reads and writes the store).
 */
import type { PersistedTabLayout } from "./tab-layout";

/**
 * The layouts to store, or null to leave the store as it is.
 * - An approved quit never writes: its teardown releases tabs and closes windows one by one, and each step would save
 *   the session smaller. A quit that stalls after that (21 Oct 2026, an update restart) must leave what the user had.
 * - No live window means the app is quitting or idle in the dock, not that the session was abandoned.
 * - electron-store rewrites and fsyncs the whole file on every set (~4 ms on the main thread), and this runs on every
 *   tab change: write only what changed, compared as stored (JSON drops `undefined`).
 */
export function layoutsToSave(facts: {
	quitApproved: boolean;
	live: PersistedTabLayout[];
	stored: unknown;
}): PersistedTabLayout[] | null {
	if (facts.quitApproved || facts.live.length === 0) return null;
	return JSON.stringify(facts.stored) === JSON.stringify(facts.live) ? null : facts.live;
}
