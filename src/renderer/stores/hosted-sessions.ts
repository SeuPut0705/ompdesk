/**
 * The sessions paired devices' tabs run on this computer (main's LocalHostServices, `IpcHostedSession`):
 * this computer's sidebar keeps each in its project group with the tab's live state, and opening one views
 * that tab (`tabs.spawn` attaches a hosted view) instead of switching another omp onto its file. Main pushes
 * the whole list on every change.
 *
 * Beside it, what this computer works on now (`HostLiveSession`, the list a paired device hears as
 * `host.liveSessions`): a row no tab of this window holds (another window's, the computer's when this is a phone's
 * page) still wears the working cue without a tap to open it first. The session files any window's tab holds
 * (`held`): an idle tab of another window keeps its row here as it does on a paired device's list of this computer.
 * And the tabs any window holds on a paired device that a session here opened (`remoteOpened`): this window nests each
 * under its opener as the window holding it does.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { HostLiveSession, IpcHostedSession, RemoteOpenedTab } from "../../shared/ipc-types";

interface HostedSessionsStore {
	sessions: readonly IpcHostedSession[];
	/** Bumped by every push; a read started before a push must not overwrite it. */
	revision: number;
	live: readonly HostLiveSession[];
	/** `revision` of `live`. */
	liveRevision: number;
	/** The session files a tab of any window of this computer holds, idle ones too (`window.omp.sessions.held`). */
	held: readonly string[];
	/** `revision` of `held`. */
	heldRevision: number;
	/** The tabs any window here holds on a paired device that a session here opened (`sessions.remoteOpened`). */
	remoteOpened: readonly RemoteOpenedTab[];
	/** `revision` of `remoteOpened`. */
	remoteOpenedRevision: number;
}

export const useHostedSessionsStore = create<HostedSessionsStore>()(() => ({
	sessions: [],
	revision: 0,
	live: [],
	liveRevision: 0,
	held: [],
	heldRevision: 0,
	remoteOpened: [],
	remoteOpenedRevision: 0,
}));

/** Read every list from main (boot, a web page's resync); a push that lands meanwhile wins over the reply. */
export async function loadHostedSessions(): Promise<void> {
	const { revision, liveRevision, heldRevision, remoteOpenedRevision } = useHostedSessionsStore.getState();
	// The rows only gain a live state; the index still lists the sessions.
	const hosted = async () => {
		try {
			const sessions = await window.omp.sessions.hosted();
			if (useHostedSessionsStore.getState().revision === revision) useHostedSessionsStore.setState({ sessions });
		} catch {}
	};
	const live = async () => {
		try {
			const live = await window.omp.sessions.live();
			if (useHostedSessionsStore.getState().liveRevision === liveRevision) useHostedSessionsStore.setState({ live });
		} catch {}
	};
	const held = async () => {
		try {
			const held = await window.omp.sessions.held();
			if (useHostedSessionsStore.getState().heldRevision === heldRevision) useHostedSessionsStore.setState({ held });
		} catch {}
	};
	const remoteOpened = async () => {
		try {
			const remoteOpened = await window.omp.sessions.remoteOpened();
			if (useHostedSessionsStore.getState().remoteOpenedRevision === remoteOpenedRevision)
				useHostedSessionsStore.setState({ remoteOpened });
		} catch {}
	};
	await Promise.all([hosted(), live(), held(), remoteOpened()]);
}

/** Boot wiring (App): the first read plus the pushes, once per window. */
export function useHostedSessionsSync(): void {
	useEffect(() => {
		const unsubscribeHosted = window.omp.events.onHostedSessionsChanged(sessions =>
			useHostedSessionsStore.setState(state => ({ sessions, revision: state.revision + 1 })),
		);
		const unsubscribeLive = window.omp.events.onLiveSessionsChanged(live =>
			useHostedSessionsStore.setState(state => ({ live, liveRevision: state.liveRevision + 1 })),
		);
		const unsubscribeHeld = window.omp.events.onHeldSessionsChanged(held =>
			useHostedSessionsStore.setState(state => ({ held, heldRevision: state.heldRevision + 1 })),
		);
		const unsubscribeRemote = window.omp.events.onRemoteOpenedChanged(remoteOpened =>
			useHostedSessionsStore.setState(state => ({
				remoteOpened,
				remoteOpenedRevision: state.remoteOpenedRevision + 1,
			})),
		);
		void loadHostedSessions();
		return () => {
			unsubscribeHosted();
			unsubscribeLive();
			unsubscribeHeld();
			unsubscribeRemote();
		};
	}, []);
}
