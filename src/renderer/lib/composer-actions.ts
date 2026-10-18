/**
 * Composer actions other surfaces ask for (the command palette's History, Expand and Attach rows): one window event,
 * `omp:composer-action`, answered by the composer of the tab it names (else the active tab) in
 * `use-composer-events.ts` — the same channel idea as `omp:fill-composer`, because the composer's history overlay,
 * expanded state and file chooser are local to it.
 */

export const COMPOSER_ACTION_EVENT = "omp:composer-action";

export type ComposerWindowAction = "history" | "expand" | "attach";

export interface ComposerActionDetail {
	action: ComposerWindowAction;
	tabId?: string;
}

export function requestComposerAction(action: ComposerWindowAction, tabId?: string): void {
	window.dispatchEvent(new CustomEvent<ComposerActionDetail>(COMPOSER_ACTION_EVENT, { detail: { action, tabId } }));
}
