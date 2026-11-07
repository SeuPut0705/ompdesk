/**
 * What a project's Delete does, for this computer's list and a paired host's alike (the confirm is
 * `ProjectDeleteDialog`): the project leaves the project list of the computer it belongs to (`useSidebarProjects
 * .remove` goes to the host's own list for a host's project), so its row leaves every window, paired view and phone
 * page at once. With `alsoSessions` the project's saved sessions are deleted first, each as a session row's Delete does
 * it: this window's tabs on the project close, then `deleteSession` (main closes every other window's tab on it,
 * and a paired device's, once the file is gone). A running session refuses, as before, and nothing is removed.
 */
import { ipcErrorCode } from "../../../../shared/ipc-error-codes";
import type { RowSession } from "../../../../shared/sidebar-rows";
import { translate } from "../../../lib/i18n";
import { useSidebarProjects } from "../../../stores/sidebar-projects";
import { useTabsStore } from "../../../stores/tabs";
import { toast } from "../../../stores/toast";

export interface ProjectDeletion {
	/** The paired host the project belongs to; absent = this computer. */
	device: string | undefined;
	/** The project's key: its folder (a linked worktree's project). */
	cwd: string;
	/** Every folder whose sessions the project holds. */
	members: readonly string[];
	sessions: readonly RowSession[];
	/** Also delete its saved sessions (the dialog's opt-in). */
	alsoSessions: boolean;
	isBusy: (session: RowSession) => boolean;
	deleteSession: (sessionPath: string) => Promise<void>;
}

/** A row with a file on its computer (a tab's row before its first write has none). */
export const isStoredRow = (session: RowSession) => session.liveTabId === undefined && !session.path.startsWith("tab:");

/** True when the project left the list; false when a refusal (a running session, a tab asking first) kept it. */
export async function deleteProject(input: ProjectDeletion): Promise<boolean> {
	if (input.alsoSessions && !(await deleteProjectSessions(input))) return false;
	await useSidebarProjects.getState().remove(input.device, input.cwd);
	return true;
}

async function deleteProjectSessions(input: ProjectDeletion): Promise<boolean> {
	const running = () => toast({ variant: "warning", message: translate("sidebar.deleteGroupStreaming") });
	if (input.sessions.some(input.isBusy)) {
		running();
		return false;
	}
	const paths = new Set(input.sessions.map(session => session.path));
	const ids = new Set(input.sessions.map(session => session.id));
	// Close this window's open tabs on the project first: a tab keeps a row (and so the project) listed, and closing it
	// releases its session file.
	const tabs = useTabsStore
		.getState()
		.tabs.filter(
			tab =>
				tab.kind !== "chat" &&
				tab.device === input.device &&
				(input.members.includes(tab.cwd) ||
					(tab.sessionPath !== undefined && paths.has(tab.sessionPath)) ||
					(tab.sessionId !== undefined && ids.has(tab.sessionId))),
		);
	for (const tab of tabs) {
		// Each closes as a deleted session's tab does: the window's last one gives way to the empty start tab.
		// eslint-disable-next-line no-await-in-loop -- each close switches the active tab
		if (!(await useTabsStore.getState().closeDeletedSession(tab.sessionPath ?? "", tab.id))) return false;
	}
	for (const session of input.sessions.filter(isStoredRow)) {
		// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
		await useTabsStore.getState().closeDeletedSession(session.path, undefined);
		try {
			// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
			await input.deleteSession(session.path);
		} catch (error) {
			if (ipcErrorCode(error) !== "session_running") throw error;
			running();
			return false;
		}
	}
	return true;
}
