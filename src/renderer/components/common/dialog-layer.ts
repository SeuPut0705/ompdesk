// DOM order is not a reliable overlay order: some dialogs render in-place and
// others portal to document.body. Track mount/open order explicitly so an
// overlay opened from Settings owns Escape even when Settings is later in DOM.
const dialogLayers: HTMLElement[] = [];

/** Register a visible dialog as the newest interaction layer. */
export function registerDialogLayer(dialog: HTMLElement | null): () => void {
	if (!dialog) return () => {};
	const existing = dialogLayers.lastIndexOf(dialog);
	if (existing >= 0) dialogLayers.splice(existing, 1);
	dialogLayers.push(dialog);
	return () => {
		const index = dialogLayers.lastIndexOf(dialog);
		if (index >= 0) dialogLayers.splice(index, 1);
	};
}

/** Whether this dialog is the most recently opened visible interaction layer. */
export function isTopmostDialog(dialog: HTMLElement | null): boolean {
	if (!dialog) return false;
	let registeredTop: HTMLElement | undefined;
	for (let index = dialogLayers.length - 1; index >= 0; index--) {
		const candidate = dialogLayers[index];
		// React removes a portal before running its effect cleanup. Keep the
		// queried layer long enough for that cleanup to decide whether focus
		// should return to its trigger.
		if (!candidate.isConnected && candidate !== dialog) {
			dialogLayers.splice(index, 1);
			continue;
		}
		registeredTop = candidate;
		break;
	}
	const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
	const domTop = dialogs[dialogs.length - 1];
	// A legacy/custom dialog that has not adopted registration still covers
	// registered layers when it is appended above them.
	if (domTop && !dialogLayers.includes(domTop)) return domTop === dialog;
	if (registeredTop) return registeredTop === dialog;
	return domTop === dialog;
}
