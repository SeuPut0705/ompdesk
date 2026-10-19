/**
 * The light a card showing a session wears (a sidebar session row, a split pane's header): the composer's rule
 * (`live-work.ts`) read for that session. `turn` while its own turn runs; `background`, fainter and slower, while
 * the turn is idle and work it started still runs; nothing while it waits on the person (that card keeps its warning
 * look) or nothing works.
 *
 * Background work is what already reaches every window, for a hidden tab and a paired host's tab alike, with no poll:
 * main's `settling` (stock's own word that its subagents, async shells or a queued wake keep the session unsettled
 * after the turn ended), the tab runtime's subagent roster (main keeps a hidden tab's current), and the sessions its
 * agent opened that run now. Each card subscribes to its own tab's stores, so a subagent's progress re-renders that
 * card only.
 */
import { memo, type ReactElement } from "react";
import { useOpenedChildren } from "../../hooks/use-opened-children";
import { SessionRuntimeProvider, useTabSessionRuntime } from "../../stores/session-runtime-context";
import { useSubagentsStore } from "../../stores/subagents";
import { LiveEdge } from "../common";
import { liveWorkState, workingAgentCount } from "./live-work";

interface SessionLiveEdgeProps {
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

function Edge({
	running,
	settling,
	waiting,
	background,
}: Omit<SessionLiveEdgeProps, "tabId" | "opened"> & {
	background: number;
}) {
	const state = liveWorkState({
		streaming: running && !settling,
		waiting: waiting ? 1 : 0,
		background: background + (running && settling ? 1 : 0),
	});
	return state ? <LiveEdge inside state={state} /> : null;
}

/** Inside the tab's runtime: its working subagents join the opened sessions. */
function AttachedEdge({ opened, ...props }: Omit<SessionLiveEdgeProps, "tabId">) {
	const agents = useSubagentsStore(s => workingAgentCount(s.subagents.values()));
	return <Edge {...props} background={agents + opened} />;
}

export const SessionLiveEdge = memo(function SessionLiveEdge({
	tabId,
	...props
}: SessionLiveEdgeProps): ReactElement | null {
	const runtime = useTabSessionRuntime(tabId);
	if (!runtime) return <Edge {...props} background={props.opened} />;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<AttachedEdge {...props} />
		</SessionRuntimeProvider>
	);
});

/** For a card that knows only its tab (a pane header, a paired host's row): the sessions it opened come from the tabs. */
export function TabLiveEdge(props: Omit<SessionLiveEdgeProps, "opened" | "tabId"> & { tabId: string | null }) {
	const opened = useOpenedChildren(props.tabId).counts.running;
	return <SessionLiveEdge {...props} opened={opened} />;
}
