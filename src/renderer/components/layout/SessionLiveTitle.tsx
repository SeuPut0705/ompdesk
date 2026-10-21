/**
 * The working cue a card showing a session wears on its own title (a sidebar session row, a split pane's header):
 * the composer's rule (`live-work.ts`) read for that session. `turn` while its own turn runs; `background`, fainter,
 * while the turn is idle and work it started still runs; `waiting`, a still warning colour, while it waits on the
 * person; plain text while nothing works.
 *
 * Background work is what already reaches every window, for a hidden tab and a paired host's tab alike, with no poll:
 * main's `settling` (stock's own word that its subagents, async shells or a queued wake keep the session unsettled
 * after the turn ended), the tab runtime's subagent roster (main keeps a hidden tab's current), and the sessions its
 * agent opened that run now. Each title subscribes to its own tab's roster, so a subagent's progress re-renders that
 * title only, and no runtime provider wraps the card (its other parts keep the focused tab's stores).
 */
import { memo, type ReactElement, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useOpenedChildren } from "../../hooks/use-opened-children";
import { useTabSessionRuntime } from "../../stores/session-runtime-context";
import type { SubagentsStore } from "../../stores/subagents";
import { type LiveState, LiveText } from "../common";
import { TimeAgo } from "../common/TimeAgo";
import { WorkingArc } from "../common/WorkingArc";
import { liveWorkState, workingAgentCount } from "./live-work";

interface SessionLiveProps {
	/** The tab holding the session; null for a session no tab of this window holds (its own state only). */
	tabId: string | null;
	/** Main reports it running (a turn, or background work keeping it unsettled). */
	running: boolean;
	/** Of `running`: the turn ended and only background work keeps it on (main's `settling`). */
	settling: boolean;
	/** It waits on the person (a question, an approval). */
	waiting: boolean;
	/** How many of the sessions its agent opened run now (not waiting). */
	opened: number;
}

/** A roster with nobody in it, for a session no tab of this window holds. */
const NO_ROSTER = createStore<Pick<SubagentsStore, "subagents">>(() => ({ subagents: new Map() }));

export function useSessionLive({ tabId, running, settling, waiting, opened }: SessionLiveProps): LiveState | null {
	const roster = useTabSessionRuntime(tabId)?.stores.get("subagents") as
		| StoreApi<Pick<SubagentsStore, "subagents">>
		| undefined;
	const agents = useStore(roster ?? NO_ROSTER, s => workingAgentCount(s.subagents.values()));
	return liveWorkState({
		streaming: running && !settling,
		waiting: waiting ? 1 : 0,
		background: agents + opened + (running && settling ? 1 : 0),
	});
}

/** For a card that knows only its tab (a pane header, a paired host's row): the sessions it opened come from the tabs. */
export function useTabLive(props: Omit<SessionLiveProps, "opened">): LiveState | null {
	const opened = useOpenedChildren(props.tabId).counts.running;
	return useSessionLive({ ...props, opened });
}

export const SessionLiveTitle = memo(function SessionLiveTitle({
	text,
	children,
	...props
}: SessionLiveProps & { text: string; children?: ReactNode }): ReactElement {
	return (
		<LiveText state={useSessionLive(props)} text={text}>
			{children}
		</LiveText>
	);
});

export function TabLiveTitle({
	text,
	children,
	...props
}: Omit<SessionLiveProps, "opened"> & { text: string; children?: ReactNode }): ReactElement {
	return (
		<LiveText state={useTabLive(props)} text={text}>
			{children}
		</LiveText>
	);
}

/**
 * A row's age slot: the time since the session last did something (`SessionInfo.modified`, ticking on the shared
 * clock), or the working arc while the session's work goes on, by the same rule as the title's light (its own turn,
 * stock's background work, its subagents, the sessions its agent opened). Waiting on the person is not working: the
 * caller shows its waiting token there instead. The age stays in the slot, hidden, so the row keeps its width.
 */
function LiveAge({ state, iso }: { state: LiveState | null; iso: string | null }): ReactElement | null {
	const working = state === "turn" || state === "background" ? state : null;
	if (!working) return iso ? <TimeAgo className="text-(--sc-text-subtle)" iso={iso} /> : null;
	return (
		<span className="omp-live-age" data-session-working={working}>
			{iso && <TimeAgo iso={iso} />}
			<WorkingArc state={working} />
		</span>
	);
}

export const SessionLiveAge = memo(function SessionLiveAge({
	iso,
	...props
}: SessionLiveProps & { iso: string | null }): ReactElement | null {
	return <LiveAge iso={iso} state={useSessionLive(props)} />;
});

export function TabLiveAge({
	iso,
	...props
}: Omit<SessionLiveProps, "opened"> & { iso: string | null }): ReactElement | null {
	return <LiveAge iso={iso} state={useTabLive(props)} />;
}
