/**
 * Workspace-directory flows (TUI /dirs /add-dir /remove-dir /move parity)
 * shared by Settings › Project folders (WorkspaceSection) and the command-registry picker/window
 * affordances. Every mutation toasts the server truth: refusals (primary
 * removal, missing path, busy while streaming) surface the agent's error
 * message, successes confirm and — for move, which re-scopes the whole
 * session cwd — rehydrate session state.
 */
import type { RpcResponse, RpcWorkspaceDirectoriesResult, RpcWorkspaceDirectory } from "../../shared/rpc-types";
import { hydrateSession } from "../hooks/use-rpc-events";
import { focusedTabDevice, pickRemoteDirectory } from "../stores/remote";
import { toast, toastError } from "../stores/toast";
import { translate } from "./i18n";

export type { RpcWorkspaceDirectory };

/**
 * Directory picker; undefined when cancelled. This device's folders use the
 * native panel (Electron openDirectory + New Folder); a paired host's folders
 * (`device`) use the remote folder picker, since the native panel cannot see
 * that disk.
 */
export async function pickWorkspaceDirectory(options?: {
	title?: string;
	buttonLabel?: string;
	device?: string;
}): Promise<string | undefined> {
	if (options?.device !== undefined) return pickRemoteDirectory(options.device);
	const paths = await window.omp.system.showOpenDialog(undefined, {
		directory: true,
		title: options?.title,
		buttonLabel: options?.buttonLabel,
	});
	return paths?.[0];
}

/** A folder for the focused tab (add-dir, move, re-root): on its own device. */
export function pickFocusedTabDirectory(): Promise<string | undefined> {
	return pickWorkspaceDirectory({ device: focusedTabDevice() });
}

/**
 * "Open project…" for the focused tab: a local tab uses main's native picker
 * (`sidecar.selectProject`); a remote tab browses its host, then re-roots
 * there (`sidecar.setProject` routes to the host). Resolves the new folder,
 * or null when cancelled or refused.
 */
export async function selectFocusedTabProject(): Promise<string | null> {
	const device = focusedTabDevice();
	if (device === undefined) return window.omp.sidecar.selectProject();
	const picked = await pickRemoteDirectory(device);
	if (!picked) return null;
	return (await window.omp.sidecar.setProject(picked)) ? picked : null;
}

function directoriesOf(response: RpcResponse): RpcWorkspaceDirectory[] {
	if (!response.success) return [];
	return (response.data as RpcWorkspaceDirectoriesResult | undefined)?.directories ?? [];
}

/** add_directory; returns the post-add list, or null on refusal (error toast shown). */
export async function addWorkspaceDirectory(path: string): Promise<RpcWorkspaceDirectory[] | null> {
	const response = await window.omp.rpc.addDirectory(path);
	if (!response.success) {
		toastError({ title: translate("workspaceDirs.add"), error: response });
		return null;
	}
	toast({ variant: "success", message: translate("workspaceDirs.added", { path }) });
	return directoriesOf(response);
}

/** remove_directory; returns the post-removal list, or null on refusal (error toast shown). */
export async function removeWorkspaceDirectory(path: string): Promise<RpcWorkspaceDirectory[] | null> {
	const response = await window.omp.rpc.removeDirectory(path);
	if (!response.success) {
		toastError({ title: translate("workspaceDirs.remove"), error: response });
		return null;
	}
	toast({ variant: "success", message: translate("workspaceDirs.removed", { path }) });
	return directoriesOf(response);
}

/**
 * move_session (TUI /move): relocates the session file's cwd association,
 * then rehydrates session state (title bar, context, composer cwd) from the
 * server truth. Returns whether the move happened.
 */
export async function moveSessionTo(path: string): Promise<boolean> {
	const response = await window.omp.rpc.moveSession(path);
	if (!response.success) {
		toastError({ title: translate("workspaceDirs.move"), error: response });
		return false;
	}
	const cwd = (response.data as { cwd?: string } | undefined)?.cwd ?? path;
	await hydrateSession();
	toast({ variant: "success", message: translate("workspaceDirs.moved", { path: cwd }) });
	return true;
}
