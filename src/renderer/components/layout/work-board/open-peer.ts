/**
 * The other live sessions in this checkout, as a work card and the board's peer rows reach them: which of a run's
 * files a peer also changed, and how a tap opens a peer. Kept apart from `session-board.ts` (the board's rows, a lazy
 * chunk) because the work card on the phone's first screen imports it.
 */
import type { CheckoutPeer, CheckoutPeers } from "../../../../../resources/gui-bridge/modes/checkout-peers-contracts";
import { routeToSessionOwner } from "../../../hooks/use-session-switch";
import { useTabsStore } from "../../../stores/tabs";
import { workFilePathKey } from "../../tools/edit-args";
import type { OpenedChildRow } from "./opened-children";

/** A live session that also changed some of these files: in this worktree, or in another worktree of the repository. */
export interface PeerOverlap {
	peer: CheckoutPeer;
	scope: "worktree" | "repo";
	files: string[];
}

/**
 * The peers' recent changes (`CheckoutPeer.files`, absolute, in this session's spelling) that meet `files` (as tools
 * named them): the same worktree's first, then the other worktrees'.
 */
export function peerOverlap(files: readonly string[], peers: CheckoutPeers | null, cwd: string): PeerOverlap[] {
	if (!peers || files.length === 0) return [];
	const mine = new Set(files.map(file => workFilePathKey(file, cwd)));
	return [
		...peers.worktree.map(peer => ({ peer, scope: "worktree" as const })),
		...peers.repo.map(peer => ({ peer, scope: "repo" as const })),
	].flatMap(({ peer, scope }) => {
		const shared = (peer.files ?? []).filter(file => mine.has(workFilePathKey(file, cwd)));
		return shared.length > 0 ? [{ peer, scope, files: shared }] : [];
	});
}

/** How a tap on one peer opens it, from where the board's own session runs. */
export type PeerOpen =
	| { kind: "switch"; tabId: string }
	| { kind: "path"; sessionPath: string; device?: string }
	| null;

/**
 * A peer tab this window holds is switched to; any other with a session file opens by that file on the computer the
 * board's session runs on (`device`: a paired host's peers are that host's files; this computer's file goes through
 * its owner, another window or a paired device's tab). A session hidden from agents (no id, no file) does not open.
 */
export function peerOpen(
	peer: CheckoutPeer,
	here: { tabs: readonly { id: string; sessionPath?: string; device?: string }[]; device?: string },
): PeerOpen {
	const held = here.tabs.find(
		tab =>
			tab.device === here.device &&
			// A peer's id is a tab id on the computer that runs it: this window's only when that is this computer.
			((peer.id !== null && !here.device && tab.id === peer.id) ||
				(peer.sessionPath !== undefined && tab.sessionPath === peer.sessionPath)),
	);
	if (held) return { kind: "switch", tabId: held.id };
	if (!peer.sessionPath) return null;
	return { kind: "path", sessionPath: peer.sessionPath, ...(here.device ? { device: here.device } : {}) };
}

/** Shows that session: switches to its tab here, else asks this computer's owner of its file, else opens the file. */
export async function openPeer(target: PeerOpen): Promise<void> {
	if (!target) return;
	const tabs = useTabsStore.getState();
	if (target.kind === "switch") {
		await tabs.switchTab(target.tabId);
		return;
	}
	// This computer's file: another window or a paired device's tab may hold it (F-OWN), so ask its owner first.
	if (!target.device) {
		const owner = await window.omp.tabs.getSessionOwner(target.sessionPath).catch(() => null);
		if (owner) {
			await routeToSessionOwner(owner, target.sessionPath);
			return;
		}
	}
	await tabs.openTab({ sessionPath: target.sessionPath, ...(target.device ? { device: target.device } : {}) });
}

/** A session this one's agent opened, shown by a tap on its row: its tab here, else its file where it runs. */
export function openOpenedChild(row: OpenedChildRow): void {
	if (row.tabId) void useTabsStore.getState().applyAgentView({ tabId: row.tabId, how: "focus" });
	else if (row.sessionPath)
		void useTabsStore.getState().openTab({
			cwd: row.cwd,
			sessionPath: row.sessionPath,
			kind: "agent",
			...(row.deviceId ? { device: row.deviceId } : {}),
		});
}
