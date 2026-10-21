import { useEffect } from "react";
import { isLiveSubagentStatus } from "../components/panels/subagent-graph";
import { useSessionStore } from "../stores/session";
import { useSubagentsStore } from "../stores/subagents";
import { useTabGuard } from "./use-tab-guard";

/** Poll cadence while a turn streams (covers frame-less parked/idle transitions). */
const STREAM_POLL_MS = 3000;

/** Starts a repeating tick and returns its stop; tests drive it by hand. */
export type PollSchedule = (tick: () => void, ms: number) => () => void;

const intervalSchedule: PollSchedule = (tick, ms) => {
	const timer = setInterval(tick, ms);
	return () => clearInterval(timer);
};

/**
 * Stream-time polling of get_subagents: lifecycle/progress frames keep the
 * store fresh while agents run, but parked/idle transitions ride the
 * AgentRegistry and emit NO wire frame — without polling, a watchdog-parked
 * agent would show "running" until the next session hydration. The poll runs
 * only while a turn streams and the roster holds a live agent: a new spawn
 * arrives as a lifecycle frame, so an empty or finished roster has nothing to
 * catch up on.
 */
export function useSubagentRosterPoll(pollMs = STREAM_POLL_MS, schedule: PollSchedule = intervalSchedule): void {
	const { capture, isActive } = useTabGuard();
	const isStreaming = useSessionStore(s => s.isStreaming);
	const hasLive = useSubagentsStore(state =>
		[...state.subagents.values()].some(agent => isLiveSubagentStatus(agent.status)),
	);
	const refresh = useSubagentsStore(state => state.refresh);
	const polling = isStreaming && hasLive;

	useEffect(() => {
		if (!polling) return;
		const ask = () => {
			// A hidden window asks nothing (the app's other polls follow the same
			// rule); it catches up once when it shows again.
			if (document.visibilityState === "hidden") return;
			// A poll resolving after a tab/session switch must not paint this
			// tab's agents over the new foreground session — the guard is
			// re-checked inside the store AFTER the await, before the write.
			const origin = capture();
			if (!isActive(origin)) return;
			void refresh({ expect: () => isActive(origin) });
		};
		const stop = schedule(ask, pollMs);
		document.addEventListener("visibilitychange", ask);
		return () => {
			stop();
			document.removeEventListener("visibilitychange", ask);
		};
	}, [capture, isActive, polling, pollMs, refresh, schedule]);
}
