/**
 * What this window knows of the sessions computers run, from main:
 *
 * - `summaries`: per computer (`""` this one, else a paired host's device id), what every session row shows of the
 *   sessions it runs (`shared/session-summary.ts`): run state, prompt, subagents, title. Built once by the computer
 *   that runs the session; this window holds each computer's at a version, applies the next change on it, and reads
 *   the whole set when it holds none or a change does not apply (it missed one). No row assembles that state from
 *   the tab events this window happened to receive.
 * - `held`: the session files a tab of any window of this computer holds, idle ones too: an idle tab of another
 *   window keeps its row here as it does on a paired device's list of this computer.
 * - `remoteOpened`: the tabs any window holds on a paired device that a session here opened: this window nests each
 *   under its opener as the window holding it does.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { RemoteOpenedTab } from "../../shared/ipc-types";
import {
	applySummaryChange,
	type SessionSummary,
	type SummariesChanged,
	unsavedSessionKey,
	type VersionedSummaries,
} from "../../shared/session-summary";

/** The key of this computer's own summaries. */
export const LOCAL_SUMMARIES = "";

interface HostedSessionsStore {
	/** Each computer's summaries as last read or changed, by device id (`LOCAL_SUMMARIES` for this computer's). */
	summaries: Readonly<Record<string, VersionedSummaries>>;
	/** The session files a tab of any window of this computer holds, idle ones too (`window.omp.sessions.held`). */
	held: readonly string[];
	/** Bumped by every push of `held`; a read started before a push must not overwrite it. */
	heldRevision: number;
	/** The tabs any window here holds on a paired device that a session here opened (`sessions.remoteOpened`). */
	remoteOpened: readonly RemoteOpenedTab[];
	/** `revision` of `remoteOpened`. */
	remoteOpenedRevision: number;
}

export const useHostedSessionsStore = create<HostedSessionsStore>()(() => ({
	summaries: {},
	held: [],
	heldRevision: 0,
	remoteOpened: [],
	remoteOpenedRevision: 0,
}));

const NO_SUMMARIES: readonly SessionSummary[] = [];

/** One computer's summaries (`device` absent: this computer's), as the store holds them. */
export function summariesOf(
	state: Pick<HostedSessionsStore, "summaries">,
	device: string | undefined,
): readonly SessionSummary[] {
	return state.summaries[device ?? LOCAL_SUMMARIES]?.sessions ?? NO_SUMMARIES;
}

/** One computer's summaries by session file, for a list of rows. */
export function useSummaryMap(device: string | undefined): ReadonlyMap<string, SessionSummary> {
	const sessions = useHostedSessionsStore(state => summariesOf(state, device));
	return useMemo(() => new Map(sessions.map(session => [session.sessionPath, session])), [sessions]);
}

/**
 * The summary of the session a tab holds, from the computer its omp runs on: by its session file, or, before its omp
 * named one, by the tab (`unsavedSessionKey`), the key a sidebar row finds it by too. Undefined until that computer
 * said.
 */
export function tabSummary(
	state: Pick<HostedSessionsStore, "summaries">,
	tab: { id: string; sessionPath?: string; device?: string },
): SessionSummary | undefined {
	const key = tab.sessionPath ?? unsavedSessionKey(tab.id);
	return summariesOf(state, tab.device).find(summary => summary.sessionPath === key);
}

/** Read one computer's summaries whole; null (an older host, a link down) leaves none for it. */
async function loadSummaries(device?: string): Promise<void> {
	const key = device ?? LOCAL_SUMMARIES;
	try {
		const read = await window.omp.sessions.summaries(device);
		const held = useHostedSessionsStore.getState().summaries[key];
		const next = read ? applySummaryChange(held ?? null, read) : null;
		if (next === held) return;
		useHostedSessionsStore.setState(state => {
			const summaries = { ...state.summaries };
			if (next) summaries[key] = next;
			else delete summaries[key];
			return { summaries };
		});
	} catch {
		// The next change, or the next resync, reads again.
	}
}

function applyChange({ device, change }: SummariesChanged): void {
	const key = device ?? LOCAL_SUMMARIES;
	const held = useHostedSessionsStore.getState().summaries[key];
	const next = applySummaryChange(held ?? null, change);
	// A change on a version this window does not hold: it missed one, so it reads the whole set.
	if (!next) {
		void loadSummaries(device);
		return;
	}
	if (next === held) return;
	useHostedSessionsStore.setState(state => ({ summaries: { ...state.summaries, [key]: next } }));
}

/**
 * Read every computer's summaries from main, this one's and every paired host's (boot, a web page's resync). From
 * then on main's pushes keep them: each change, and each host's whole set again when its link comes up. No view
 * reads them on its own. A push that lands meanwhile wins over the reply.
 */
export async function loadHostedSessions(): Promise<void> {
	const { heldRevision, remoteOpenedRevision } = useHostedSessionsStore.getState();
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
	const hosts = async () => {
		try {
			const { hosts } = await window.omp.remote.getState();
			await Promise.all(hosts.map(host => loadSummaries(host.deviceId)));
		} catch {}
	};
	await Promise.all([held(), remoteOpened(), loadSummaries(), hosts()]);
}

/** Boot wiring (App): the first read plus the pushes, once per window. */
export function useHostedSessionsSync(): void {
	useEffect(() => {
		const unsubscribeSummaries = window.omp.events.onSummariesChanged(applyChange);
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
			unsubscribeSummaries();
			unsubscribeHeld();
			unsubscribeRemote();
		};
	}, []);
}
