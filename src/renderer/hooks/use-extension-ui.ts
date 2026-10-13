import { useCallback, useEffect } from "react";
import type { ExtensionUIResponse } from "../../shared/rpc-types";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { pushTabExtensionUiRequest } from "../stores/tabs";

/** Answers stay attached to the originating process, even when request ids collide. */
export function useExtensionUiResponder(): (response: ExtensionUIResponse) => void {
	const tabId = useRuntimeTabId();
	return useCallback(
		(response: ExtensionUIResponse) => {
			if (tabId) window.omp.ui.respondExtensionUi(response, tabId);
			else window.omp.ui.respondExtensionUi(response);
		},
		[tabId],
	);
}

/** Routes every extension UI request into the tab that raised it. */
export function useExtensionUi(): void {
	useEffect(() => window.omp.events.onExtensionUi((request, tabId) => pushTabExtensionUiRequest(tabId, request)), []);
}
