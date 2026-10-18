/**
 * Whether a tab's omp has finished starting, as the tab list knows it. A command for a tab that is still starting
 * waits behind this (tab-runtime.ts) instead of failing, so a new session's composer works at once and its first
 * message leaves when the omp is ready (AGENTS.md › No loading screens). It has no imports on purpose: tabs.ts
 * installs the gate and tab-runtime.ts reads it, and those two import each other through the stores.
 */

/** The longest a command waits for a starting omp before it goes out anyway (and fails the way it always did). */
export const READY_WAIT_CAP_MS = 120_000;

type Gate = (tabId: string) => Promise<void> | null;

let gate: Gate = () => null;

/** tabs.ts: resolves once the tab is no longer starting (null when it is not starting now). */
export function installTabReadyGate(next: Gate): void {
	gate = next;
}

export function tabReady(tabId: string): Promise<void> | null {
	return gate(tabId);
}
