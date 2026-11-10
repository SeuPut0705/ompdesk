/**
 * The working cue a card showing a session wears on its own title (a sidebar session row, a split pane's header):
 * the composer's rule (`live-work.ts`) read for that session. `turn` while its own turn runs; `background`, fainter,
 * while the turn is idle and work it started still runs; `waiting`, a still warning colour, while it waits on the
 * person; plain text while nothing works.
 *
 * Both read the session's summary (`shared/session-summary.ts`: main's `settling` and its working subagents, as the
 * computer running it built them) and the sessions its agent opened that run now.
 */
import { memo, type ReactElement } from "react";
import type { SessionSummary } from "../../../shared/session-summary";
import { useOpenedChildren } from "../../hooks/use-opened-children";
import type { SessionRun } from "../../lib/session-run";
import type { TitleParts } from "../../lib/session-title";
import { type LiveState, SessionTitle, TimeAgo, WorkingArc } from "../common";
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

/** For a card that knows only its tab (a pane header): the sessions it opened come from the tab. */
export function useTabLive(
	tabId: string,
	summary: SessionSummary | undefined,
	run: Pick<SessionRun, "running" | "settling" | "waiting">,
): LiveState | null {
	const opened = useOpenedChildren(tabId).counts.running;
	return sessionLive({
		running: run.running,
		settling: run.settling,
		waiting: run.waiting,
		opened,
		agents: workingAgentCount(summary?.agents ?? []),
	});
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
