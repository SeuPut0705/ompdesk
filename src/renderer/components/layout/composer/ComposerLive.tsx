/**
 * The composer's "work is going on" cue. Two states, one light: while the main turn runs the box's
 * border carries a slow accent light (`turn`); between turns, while this tab's subagents or
 * background shells still run, the same light is fainter and slower and the Send button gets a ring
 * with a tooltip saying that sending starts a turn right away (`background`). A question or approval
 * waiting on the user wins: the warning card owns the attention and the cue stays off.
 *
 * Everything is read from the stores the work board and the dock read (the run state, the subagent
 * store, the shared jobs poll); nothing here polls. The animation is a transform on one layer
 * (components.css `.omp-composer-live`), paused while the window is hidden.
 */
import { type ComponentProps, type ReactElement, type ReactNode, useSyncExternalStore } from "react";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useT } from "../../../lib/i18n";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { Tooltip } from "../../common";
import { type ComposerLiveState, composerLiveState, workingAgentCount } from "./composer-live";

function subscribeVisibility(listener: () => void): () => void {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
}
const documentVisible = () => document.visibilityState !== "hidden";

/** The cue this tab's composer shows, and how many agents and shells stand behind a background one. */
export function useComposerLive(): { state: ComposerLiveState | null; background: number } {
	const streaming = useSessionStore(s => s.isStreaming);
	const agents = useSubagentsStore(s => workingAgentCount(s.subagents.values()));
	const shells = useBackgroundJobs().length;
	const blocking = useExtensionUiStore(
		s => s.pendingRequests.filter(request => isUserBlockingRequest(s, request)).length,
	);
	const proposal = usePlanApprovalStore(s => s.pending !== null);
	const background = agents + shells;
	return {
		state: composerLiveState({ streaming, waiting: blocking + (proposal ? 1 : 0), background }),
		background,
	};
}

/** The light along the composer box's border; mount it first inside `.omp-composer-box`. */
export function ComposerLiveEdge(): ReactElement | null {
	const { state } = useComposerLive();
	const visible = useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
	if (!state) return null;
	return (
		<span
			aria-hidden
			className="omp-composer-live"
			data-composer-live={state}
			data-paused={visible ? undefined : ""}
		/>
	);
}

/** Wraps the Send button: its tooltip and ring tell that background work runs and a send starts at once. */
export function ComposerSend({
	label,
	shortcut,
	children,
}: {
	label: string;
	/** macOS-spelled chord shown after the tooltip text. */
	shortcut?: string;
	children: ComponentProps<typeof Tooltip>["children"];
}): ReactNode {
	const t = useT();
	const { state, background } = useComposerLive();
	const live = state === "background";
	return (
		<span className="omp-composer-send-live" data-composer-live={live ? "background" : undefined}>
			<Tooltip content={live ? t("input.live.background", { count: background }) : label} shortcut={shortcut}>
				{children}
			</Tooltip>
		</span>
	);
}
