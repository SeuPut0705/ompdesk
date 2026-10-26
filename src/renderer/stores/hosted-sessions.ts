/**
 * The sessions paired devices' tabs run on this computer (main's LocalHostServices, `IpcHostedSession`):
 * this computer's sidebar keeps each in its project group with the tab's live state, and opening one views
 * that tab (`tabs.spawn` attaches a hosted view) instead of switching another omp onto its file. Main pushes
 * the whole list on every change.
 *
 * Beside it, what this computer works on now (`HostLiveSession`, the list a paired device hears as
 * `host.liveSessions`): a row no tab of this window holds (another window's, the computer's when this is a phone's
 * page) still wears the working cue without a tap to open it first.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { HostLiveSession, IpcHostedSession } from "../../shared/ipc-types";

interface HostedSessionsStore {
	sessions: readonly IpcHostedSession[];
	/** Bumped by every push; a read started before a push must not overwrite it. */
	revision: number;
	live: readonly HostLiveSession[];
	/** `revision` of `live`. */
	liveRevision: number;
}

export const useHostedSessionsStore = create<HostedSessionsStore>()(() => ({
	sessions: [],
	revision: 0,
	live: [],
	liveRevision: 0,
}));

/** Read both lists from main (boot, a web page's resync); a push that lands meanwhile wins over the reply. */
export async function loadHostedSessions(): Promise<void> {
	const { revision, liveRevision } = useHostedSessionsStore.getState();
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
	await Promise.all([hosted(), live()]);
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
		void loadHostedSessions();
		return () => {
			unsubscribeHosted();
			unsubscribeLive();
		};
	}, []);
}
