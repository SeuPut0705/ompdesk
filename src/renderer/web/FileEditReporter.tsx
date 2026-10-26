import { useEffect } from "react";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { webRuntime } from "./runtime";

/**
 * Tells the computer which tab's Files editor holds unsaved edits, on every change and on every (re)connect. The
 * computer may close one of this page's tabs for an agent while the page is away, and only closes one this page said
 * is clean. Nothing in the desktop app, whose window closes its own tab and refuses one with unsaved edits.
 */
export function FileEditReporter() {
	if (!webRuntime()) return null;
	return <ReportFileEdits />;
}

function ReportFileEdits() {
	const dirty = useUiStore(state => state.fileEditDirty);
	const owner = useUiStore(state => state.fileEditTabId);
	const active = useTabsStore(state => state.activeTabId);
	// The panel names the owner a moment after the editor turns dirty: until then the edits are the focused tab's.
	const dirtyTabId = dirty ? (owner ?? active) : null;

	useEffect(() => {
		const send = () => void window.omp.tabs.reportFileEdits(dirtyTabId).catch(() => undefined);
		send();
		return webRuntime()?.onConnectionState(state => {
			if (state === "open") send();
		});
	}, [dirtyTabId]);

	return null;
}
