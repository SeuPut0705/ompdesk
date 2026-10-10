import { useCallback, useEffect } from "react";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../../shared/rpc-types";
import { useExtensionUiStore } from "../stores/extension-ui";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { pushTabExtensionUiRequest } from "../stores/tabs";

interface ExtensionUiResult {
	currentRequest: ExtensionUIRequest | null;
	respond: (response: ExtensionUIResponse) => void;
	cancel: (id: string) => void;
}

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

/**
 * Subscribes to extension UI requests and manages the dialog queue.
 */
export function useExtensionUi(): ExtensionUiResult {
	const sendResponse = useExtensionUiResponder();
	const pendingRequests = useExtensionUiStore(s => s.pendingRequests);
	const removeRequest = useExtensionUiStore(s => s.removeRequest);

	useEffect(() => {
		const unsubscribe = window.omp.events.onExtensionUi((request, tabId) => {
			pushTabExtensionUiRequest(tabId, request);
		});
		return unsubscribe;
	}, []);

	const respond = useCallback(
		(response: ExtensionUIResponse) => {
			sendResponse(response);
			removeRequest(response.id);
		},
		[removeRequest, sendResponse],
	);

	const cancel = useCallback(
		(id: string) => {
			sendResponse({ type: "extension_ui_response", id, cancelled: true });
			removeRequest(id);
		},
		[removeRequest, sendResponse],
	);

	return {
		currentRequest: pendingRequests.length > 0 ? pendingRequests[0] : null,
		respond,
		cancel,
	};
}
