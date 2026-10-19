/**
 * "Save diagnostic bundle" from the sidebar's session menu and Settings › Updates & about: one call to main
 * (`sessions.saveDiagnosticBundle`: the save dialog, stock's `/dump` zip of the tab's omp, OMPdesk's diagnostics
 * text added), then one toast. Option/Alt while choosing the item, or its anonymized twin, asks for stock's
 * `/dump anon`.
 */
import type { DiagnosticBundleRequest } from "../../shared/diagnostic-bundle";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import { useTabsStore } from "../stores/tabs";
import { toast, toastError } from "../stores/toast";
import { errorMessage } from "./error-detail";
import { translate } from "./i18n";

/** Failures that say what to do, not what broke: a warning, nothing for the runtime log. */
const EXPECTED_CODES: Record<string, true> = {
	no_messages: true,
	session_not_open: true,
	unknown_tab: true,
	session_hidden: true,
};

/** One save at a time: a second press while the dialog or the dump is open would queue another dialog. */
let saving = false;

/** Which session: an open tab, and its title for the default file name. */
export type DiagnosticBundleSource = Pick<DiagnosticBundleRequest, "tabId" | "title">;

export async function saveDiagnosticBundle(source: DiagnosticBundleSource, anonymized: boolean): Promise<void> {
	if (saving) return;
	saving = true;
	try {
		const result = await window.omp.sessions.saveDiagnosticBundle({ ...source, anonymized });
		if (result.ok) {
			toast({ variant: "success", title: translate("diagnosticBundle.saved"), message: result.path });
		} else if (result.cancelled) {
			return;
		} else if (Object.hasOwn(EXPECTED_CODES, ipcErrorCode(result) ?? "")) {
			toast({ variant: "warning", message: errorMessage(result) });
		} else {
			toastError({ title: translate("diagnosticBundle.failed"), error: result });
		}
	} catch (cause) {
		toastError({ title: translate("diagnosticBundle.failed"), error: cause });
	} finally {
		saving = false;
	}
}

/** Settings' button: the tab in focus (a paired host's tab dumps on the host). */
export function saveFocusedDiagnosticBundle(anonymized: boolean): Promise<void> {
	const { tabs, activeTabId } = useTabsStore.getState();
	const tab = tabs.find(candidate => candidate.id === activeTabId && !candidate.ghost);
	if (!tab) {
		toast({ variant: "warning", message: translate("diagnosticBundle.noSession") });
		return Promise.resolve();
	}
	return saveDiagnosticBundle({ tabId: tab.id, ...(tab.title ? { title: tab.title } : {}) }, anonymized);
}
