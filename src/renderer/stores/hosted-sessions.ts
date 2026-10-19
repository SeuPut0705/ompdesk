/**
 * The sessions paired devices' tabs run on this computer (main's LocalHostServices, `IpcHostedSession`):
 * this computer's sidebar keeps each in its project group with the tab's live state, and opening one views
 * that tab (`tabs.spawn` attaches a hosted view) instead of switching another omp onto its file. Main pushes
 * the whole list on every change.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { IpcHostedSession } from "../../shared/ipc-types";

interface HostedSessionsStore {
	sessions: readonly IpcHostedSession[];
	/** Bumped by every push; a read started before a push must not overwrite it. */
	revision: number;
}

export const useHostedSessionsStore = create<HostedSessionsStore>()(() => ({ sessions: [], revision: 0 }));

/** Read the list from main (boot, a web page's resync); a push that lands meanwhile wins over the reply. */
export async function loadHostedSessions(): Promise<void> {
	const { revision } = useHostedSessionsStore.getState();
	try {
		const sessions = await window.omp.sessions.hosted();
		if (useHostedSessionsStore.getState().revision === revision) useHostedSessionsStore.setState({ sessions });
	} catch {
		// The rows only gain a live state; the index still lists the sessions.
	}
}

/** Boot wiring (App): the first read plus the push, once per window. */
export function useHostedSessionsSync(): void {
	useEffect(() => {
		const unsubscribe = window.omp.events.onHostedSessionsChanged(sessions =>
			useHostedSessionsStore.setState(state => ({ sessions, revision: state.revision + 1 })),
		);
		void loadHostedSessions();
		return unsubscribe;
	}, []);
}
