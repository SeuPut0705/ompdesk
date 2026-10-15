import { useCallback, useEffect } from "react";
import type { ExtensionUIResponse } from "../../shared/rpc-types";
import { translate } from "../lib/i18n";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { endTabSignIn, pushTabExtensionUiRequest, restoreTabExtensionUiRequests } from "../stores/tabs";
import { toastError } from "../stores/toast";

/**
 * Answers stay attached to the originating process, even when request ids collide. The promise
 * resolves true once main handed the answer on; false when it could not (a paired host's tab
 * while its link is down): the caller keeps the card open and a toast says why.
 */
export function useExtensionUiResponder(): (response: ExtensionUIResponse) => Promise<boolean> {
	const tabId = useRuntimeTabId();
	return useCallback(
		async (response: ExtensionUIResponse) => {
			try {
				if (tabId) await window.omp.ui.respondExtensionUi(response, tabId);
				else await window.omp.ui.respondExtensionUi(response);
				return true;
			} catch (error) {
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
		const offUi = window.omp.events.onExtensionUi((request, tabId, signIn) =>
			pushTabExtensionUiRequest(tabId, request, signIn),
		);
		const offSignIn = window.omp.events.onSignInEnded(({ tabId, error }) => endTabSignIn(tabId, error));
		void window.omp.ui.openRequests().then(restoreTabExtensionUiRequests);
		return () => {
			offUi();
			offSignIn();
		};
	}, []);
}
