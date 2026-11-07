/**
 * The working cue a card showing a session wears on its own title (a sidebar session row, a split pane's header):
 * the composer's rule (`live-work.ts`) read for that session. `turn` while its own turn runs; `background`, fainter,
 * while the turn is idle and work it started still runs; `waiting`, a still warning colour, while it waits on the
 * person; plain text while nothing works.
 *
 * A sidebar row reads its background work from the session's summary (`shared/session-summary.ts`: main's `settling`
 * and its working subagents, as the computer running it built them) and the sessions its agent opened that run now; a
 * split pane's header shows its own tab, whose full stream it has, so it reads that tab's roster.
 */
import { memo, type ReactElement } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useOpenedChildren } from "../../hooks/use-opened-children";
import type { TitleParts } from "../../lib/session-title";
import { useTabSessionRuntime } from "../../stores/session-runtime-context";
import type { SubagentsStore } from "../../stores/subagents";
import { type LiveState, SessionTitle } from "../common";
import { TimeAgo } from "../common/TimeAgo";
import { WorkingArc } from "../common/WorkingArc";
import { liveWorkState, workingAgentCount } from "./live-work";

interface SessionLiveProps {
	/** Main reports it running (a turn, or background work keeping it unsettled). */
	running: boolean;
	/** Of `running`: the turn ended and only background work keeps it on (main's `settling`). */
	settling: boolean;
	/** It waits on the person (a question, an approval). */
	waiting: boolean;
	/** How many of the sessions its agent opened run now (not waiting). */
	opened: number;
	/** How many of its subagents work now (`workingAgentCount` of its summary's agents). */
	agents: number;
}

function sessionLive({ running, settling, waiting, opened, agents }: SessionLiveProps): LiveState | null {
	return liveWorkState({
		streaming: running && !settling,
		waiting: waiting ? 1 : 0,
		background: agents + opened + (running && settling ? 1 : 0),
	});
}

/** A roster with nobody in it, for a pane whose tab has no runtime yet. */
const NO_ROSTER = createStore<Pick<SubagentsStore, "subagents">>(() => ({ subagents: new Map() }));

/** For a card that knows only its tab (a pane header): its roster and the sessions it opened come from the tab. */
export function useTabLive(
	props: Omit<SessionLiveProps, "opened" | "agents"> & { tabId: string | null },
): LiveState | null {
	const opened = useOpenedChildren(props.tabId).counts.running;
	const roster = useTabSessionRuntime(props.tabId)?.stores.get("subagents") as
		| StoreApi<Pick<SubagentsStore, "subagents">>
		| undefined;
	const agents = useStore(roster ?? NO_ROSTER, s => workingAgentCount(s.subagents.values()));
	return sessionLive({ ...props, opened, agents });
}

export const SessionLiveTitle = memo(function SessionLiveTitle({
	parts,
	swapScope,
	...props
}: SessionLiveProps & { parts: TitleParts; swapScope?: string }): ReactElement {
	return <SessionTitle live={sessionLive(props)} noTooltip parts={parts} swapScope={swapScope} />;
});

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
	return <LiveAge iso={iso} state={sessionLive(props)} />;
});
