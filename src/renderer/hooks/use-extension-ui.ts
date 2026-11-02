import { useCallback, useEffect } from "react";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type { ExtensionUIResponse } from "../../shared/rpc-types";
import { translate } from "../lib/i18n";
import { holdAnswer, sendsHeld } from "../lib/outbox-delivery";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import {
	endTabSignIn,
	pushTabExtensionUiRequest,
	restoreTabExtensionUiRequests,
	setTabSignInRelay,
	useTabsStore,
} from "../stores/tabs";
import { toast, toastError } from "../stores/toast";

/**
 * Answers stay attached to the originating process, even when request ids collide. The promise
 * resolves true once main handed the answer on, once the ask turned out to be answered already by
 * another device (`already_answered`: the caller closes the card for good and the reader is told so),
 * or once the answer waits in the outbox because the link to the computer running the tab is down
 * (lib/outbox-delivery.ts sends it when the link is back); false when it could not: the caller keeps
 * the card open and a toast says why.
 */
export function useExtensionUiResponder(): (response: ExtensionUIResponse) => Promise<boolean> {
	const tabId = useRuntimeTabId();
	return useCallback(
		async (response: ExtensionUIResponse) => {
			const tab = useTabsStore.getState().tabs.find(entry => entry.id === tabId);
			if (tab && sendsHeld(tab)) {
				holdAnswer(tab, response);
				return true;
			}
			try {
				if (tabId) await window.omp.ui.respondExtensionUi(response, tabId);
				else await window.omp.ui.respondExtensionUi(response);
				return true;
			} catch (error) {
				if (ipcErrorCode(error) === "already_answered") {
					toast({ variant: "info", message: translate("extDialog.answeredElsewhere") });
					return true;
				}
				toastError({ title: translate("extDialog.answerFailed"), error });
				return false;
			}
		},
		[tabId],
	);
}

/** Routes every extension UI request into the tab that raised it, and takes back the ones this page loaded too late to see. */
export function useExtensionUi(): void {
	useEffect(() => {
		const offUi = window.omp.events.onExtensionUi((request, tabId, signIn, _resent, answeredElsewhere) =>
			pushTabExtensionUiRequest(tabId, request, signIn, answeredElsewhere),
		);
		const offSignIn = window.omp.events.onSignInEnded(({ tabId, error }) => endTabSignIn(tabId, error));
		const offRelay = window.omp.events.onSignInRelay(({ tabId, relay }) => setTabSignInRelay(tabId, relay));
		// What was shown and asked before this listener existed (a reload, a new window, or frames sent while the page
		// was still starting: nightly 39539556435 lost a status set 24 ms before the listener came up).
		// A read a dropped link fails is no loss: a web page's resync reads both again (settleTabExtensionUiRequests).
		void window.omp.ui.shownState().then(restoreTabExtensionUiRequests, () => undefined);
		void window.omp.ui.openRequests().then(restoreTabExtensionUiRequests, () => undefined);
		return () => {
			offUi();
			offSignIn();
			offRelay();
		};
	}, []);
}
