/**
 * What the page is doing right now, read from the app's own stores for `safeToReload` (sw-update.ts): a reload
 * never lands on anything the user made and has not finished with.
 */
import { useComposerStore } from "../stores/composer";
import { useExtensionUiStore } from "../stores/extension-ui";
import { usePlanApprovalStore } from "../stores/plan-approval";
import { useUiStore } from "../stores/ui";
import { useHostUiStore } from "./host-ui/host-ui-store";
import type { SafeMoment } from "./sw-update";
import { uploadsInFlight } from "./upload";

export function pageSafeMoment(isVisible: () => boolean = () => document.visibilityState === "visible"): SafeMoment {
	return {
		visible: isVisible,
		draftEmpty: () => {
			const composer = useComposerStore.getState();
			return composer.draft.trim() === "" && composer.images.length === 0;
		},
		askOpen: () =>
			useExtensionUiStore.getState().pendingRequests.length > 0 || usePlanApprovalStore.getState().pending !== null,
		uploading: () => uploadsInFlight() > 0,
		// Unsaved Files editor changes (or a switch held back until "Discard"), and any host sheet or
		// dialog on screen: the editor and models-config sheets keep their draft in the sheet itself.
		editing: () => {
			const ui = useUiStore.getState();
			return ui.fileEditDirty || ui.pendingFileSwitch !== null || useHostUiStore.getState().queue.length > 0;
		},
	};
}
