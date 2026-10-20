/**
 * The composer's "work is going on" cue. One light: while the main turn runs the box's border carries a soft accent
 * comet (`turn`); between turns, while this tab's subagents or background shells still run, the same comet is dimmer
 * and the Send button gets a still ring with a tooltip saying that sending starts a turn right away (`background`).
 * A question or approval waiting on the user wins: the comet fades out and the edge holds a still warning tint.
 *
 * Everything is read from the stores the work board and the dock read (the run state, the subagent
 * store, the shared jobs poll); nothing here polls. The light itself is the shared `common/LiveEdge`
 * (components.css `.omp-live-edge`), the same one a running session's sidebar row and pane header wear.
 */
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { useTabPollKey } from "../../../hooks/use-tab-poll";
import { useT } from "../../../lib/i18n";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { LiveEdge, type LiveEdgeState, Tooltip } from "../../common";
import { liveWorkState, workingAgentCount } from "../live-work";

/** The cue this tab's composer shows, and how many agents and shells stand behind a background one. */
export function useComposerLive(): { state: LiveEdgeState | null; background: number } {
	const streaming = useSessionStore(s => s.isStreaming);
	const agents = useSubagentsStore(s => workingAgentCount(s.subagents.values()));
	const shells = useBackgroundJobs().length;
	const blocking = useExtensionUiStore(
		s => s.pendingRequests.filter(request => isUserBlockingRequest(s, request)).length,
	);
	const proposal = usePlanApprovalStore(s => s.pending !== null);
	const tabId = useRuntimeTabId();
	const sessions = useOpenedChildren(tabId).counts.running;
	// Stock's own word that background work keeps the session unsettled (main's `settling`): at least one thing runs,
	// even when the jobs poll has not read it yet or it is something the poll does not list. Same tab as that poll.
	const pollTab = useTabPollKey();
	const settling = useTabsStore(s => s.tabs.some(tab => tab.id === pollTab && tab.settling === true));
	const background = Math.max(agents + shells + sessions, settling ? 1 : 0);
	return {
		state: liveWorkState({ streaming, waiting: blocking + (proposal ? 1 : 0), background }),
		background,
	};
}

/** The light along the composer box's border; mount it first inside `.omp-composer-box`. */
export function ComposerLiveEdge(): ReactElement | null {
	return <LiveEdge state={useComposerLive().state} />;
}

/** Wraps the composer's action button: its tooltip and ring tell that background work runs and a send starts at once. */
export function ComposerSend({
	label,
	shortcut,
	cue = true,
	children,
}: {
	label: string;
	/** macOS-spelled chord shown after the tooltip text. */
	shortcut?: string;
	/** The button sends (false while it is Stop, which the background cue does not describe). */
	cue?: boolean;
	children: ComponentProps<typeof Tooltip>["children"];
}): ReactNode {
	const t = useT();
	const { state, background } = useComposerLive();
	const live = cue && state === "background";
	return (
		<span className="omp-composer-send-live" data-composer-live={live ? "background" : undefined}>
			<Tooltip content={live ? t("input.live.background", { count: background }) : label} shortcut={shortcut}>
				{children}
			</Tooltip>
		</span>
	);
}
