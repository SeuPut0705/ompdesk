/**
 * The light a card showing a session wears (a sidebar session row, a split pane's header): the composer's rule
 * (`live-work.ts`) read for that session. `turn` while its own turn runs; `background`, fainter and slower, while
 * the turn is idle and its subagents, its background shells or the sessions its agent opened still run; nothing
 * while it waits on the person (that card keeps its warning look) or nothing works.
 *
 * Reads only what is already there: the tab's subagent roster (main keeps a hidden tab's current), the opened
 * sessions the caller counted from its rows, and the background jobs a surface of that tab polls (so shells count
 * while the tab's pane is on screen; a list of every tab starts no poll of its own). Each card subscribes to its own
 * tab's stores, so a subagent's progress re-renders that card only.
 */
import { memo, type ReactElement } from "react";
import { useRunningJobsPeek } from "../../hooks/use-background-jobs";
import { SessionRuntimeProvider, useTabSessionRuntime } from "../../stores/session-runtime-context";
import { useSubagentsStore } from "../../stores/subagents";
import { LiveEdge } from "../common";
import { liveWorkState, workingAgentCount } from "./live-work";

interface SessionLiveEdgeProps {
	/** The tab holding the session; null for a session no tab of this window holds (its own state only). */
	tabId: string | null;
	/** Its own turn runs. */
	running: boolean;
	/** It waits on the person (a question, an approval). */
	waiting: boolean;
	/** How many of the sessions its agent opened run now (not waiting). */
	opened: number;
}

function Edge({ running, waiting, background }: { running: boolean; waiting: boolean; background: number }) {
	const state = liveWorkState({ streaming: running, waiting: waiting ? 1 : 0, background });
	return state ? <LiveEdge inside state={state} /> : null;
}

/** Inside the tab's runtime: its working subagents and the shells its pane polls join the opened sessions. */
function AttachedEdge({ tabId, running, waiting, opened }: SessionLiveEdgeProps & { tabId: string }) {
	const agents = useSubagentsStore(s => workingAgentCount(s.subagents.values()));
	const shells = useRunningJobsPeek(tabId);
	return <Edge background={agents + shells + opened} running={running} waiting={waiting} />;
}

export const SessionLiveEdge = memo(function SessionLiveEdge(props: SessionLiveEdgeProps): ReactElement | null {
	const runtime = useTabSessionRuntime(props.tabId);
	if (!runtime || props.tabId === null)
		return <Edge background={props.opened} running={props.running} waiting={props.waiting} />;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<AttachedEdge {...props} tabId={props.tabId} />
		</SessionRuntimeProvider>
	);
});
