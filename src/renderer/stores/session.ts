import type { VirtualItem } from "@tanstack/react-virtual";
import { createStore } from "zustand/vanilla";
import type { CheckoutPeers } from "../../../resources/gui-bridge/modes/checkout-peers-contracts";
import type { NextPromptState, NextPromptUnavailable } from "../../../resources/gui-bridge/modes/next-prompt-contracts";
import type { ContextUsage, RpcSessionState, SidecarRestartProgress, SidecarStatus } from "../../shared/rpc-types";
import { createScopedStoreHook } from "./session-runtime-context";

export interface TranscriptView {
	sessionId: string;
	pinned: boolean;
	preCompactionOpen: boolean;
	expandedProcessKeys: Set<string>;
	scrollOffset: number;
	anchorKey?: string;
	anchorOffset: number;
	measurements: VirtualItem[];
}

export interface SessionStore {
	switchPending: { fromId: string; toId: string } | null;
	setSwitchPending: (pending: { fromId: string; toId: string } | null) => void;
	/** Live event revision; a delayed snapshot cannot overwrite a newer lifecycle transition. */
	eventVersion: number;
	transcriptView: TranscriptView | null;
	saveTranscriptView: (view: TranscriptView) => void;
	/** Bumped when the transcript must snap back to the live edge (the user just
	 * sent a message). Per-tab stores, so a tab switch can't strand another pane. */
	transcriptPinNonce: number;
	pinTranscriptToBottom: () => void;
	sessionId: string;
	sessionName: string | null;
	sessionFile: string | null;
	cwd: string;
	sidecarError: string | null;
	/** Crash-loop progress carried by the status behind `sidecarError`: non-null
	 * while the sidecar is respawning itself, and on the terminal error once the
	 * attempts run out. Null for renderer-detected health failures. */
	sidecarRestart: SidecarRestartProgress | null;
	/** The banner was dismissed by the user. A new diagnostic — or the sidecar
	 * coming back — clears it; the one that was closed stays hidden. */
	sidecarDismissed: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	/** Client clock (Date.now()) of the current turn_start while no assistant
	 * message has begun streaming — drives the chat's pending-model indicator
	 * so a stalled provider request is visibly alive instead of dead air. */
	awaitingModelSince: number | null;
	/** Live auto-retry window (auto_retry_start → auto_retry_end): drives the
	 * inline retry row with a live countdown. `startedAt` is the client clock
	 * at event time so the countdown survives re-renders. */
	retryInfo: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; startedAt: number } | null;
	/** Live compaction window: auto (auto_compaction_start → auto_compaction_end) carries the TUI
	 * loader's reason/action text for the inline status row; `manual` is a /compact (`compact`) or
	 * handoff (`handoff`) the GUI started, held for as long as its request runs, and `cancelling`
	 * once the reader stopped it. */
	compactionInfo: {
		reason: "threshold" | "overflow" | "idle" | "incomplete" | "manual";
		action: string;
		cancelling?: boolean;
	} | null;
	status: SidecarStatus;
	contextUsage: ContextUsage | null;
	/** Bumped every time a get_state snapshot actually carries fresh context
	 * usage. Cost displays pace their refetch on this instead of on message
	 * appends, so spend that arrives without a new transcript entry (subagent
	 * billing, another window on the same session) still gets picked up. */
	statsPulse: number;
	messageCount: number;
	queuedMessageCount: number;
	planModeEnabled: boolean;
	/** The mode the app entered by itself for the last prompt (the composer's "Auto: Plan" chip); cleared when that mode ends or is undone. */
	autoMode: "plan" | "goal" | null;
	/** Whether a prewalk model switch is armed and waiting for the first edit/write. */
	prewalkArmed: boolean;
	agentsPaused: boolean;
	agentsPausedAt: number | null;
	goal: { objective?: string } | null;
	goalState: { status?: string } | null;
	/** The built-in prompt suggestions' state of this tab's bridge (next_prompt_config frames,
	 * hydrated via get_next_prompt). null = not reported / unsupported omp: the legacy widget path stays. */
	nextPrompt: NextPromptState | null;
	/** Why the last suggestion request failed (next_prompt_update unavailable); cleared by the next ready. */
	nextPromptUnavailable: { reason: NextPromptUnavailable; detail?: string } | null;
	/** The other live sessions in this tab's worktree or repository, null while it works alone (`checkout_peers`
	 * frames, hydrated via get_checkout_peers): the work board's "same checkout" row. */
	checkoutPeers: CheckoutPeers | null;
	setFromState: (state: RpcSessionState) => void;
	setStatus: (status: SidecarStatus, cwd: string) => void;
	setSidecarError: (error: string | null, restart?: SidecarRestartProgress | null) => void;
	clearSidecarError: () => void;
	dismissSidecarBanner: () => void;
	reset: () => void;
}

const initialState = {
	switchPending: null as { fromId: string; toId: string } | null,
	eventVersion: 0,
	transcriptView: null as TranscriptView | null,
	transcriptPinNonce: 0,
	sessionId: "",
	sessionName: null,
	sessionFile: null,
	cwd: "",
	sidecarError: null as string | null,
	sidecarRestart: null as SidecarRestartProgress | null,
	sidecarDismissed: false,
	isStreaming: false,
	isCompacting: false,
	awaitingModelSince: null,
	retryInfo: null,
	compactionInfo: null,
	status: "starting" as SidecarStatus,
	contextUsage: null,
	statsPulse: 0,
	messageCount: 0,
	queuedMessageCount: 0,
	planModeEnabled: false,
	autoMode: null as "plan" | "goal" | null,
	prewalkArmed: false,
	agentsPaused: false,
	agentsPausedAt: null,
	goal: null,
	goalState: null,
	nextPrompt: null,
	nextPromptUnavailable: null,
	checkoutPeers: null as CheckoutPeers | null,
};

/**
 * The composer modes a `get_state` snapshot reports that no session event
 * carries: plan mode, the prewalk arm and the agents pause gate change only
 * through a snapshot or the GUI's own command replies, so events that landed
 * while the snapshot was in flight cannot have outdated them.
 */
export function snapshotModeState(
	state: RpcSessionState,
): Pick<SessionStore, "planModeEnabled" | "prewalkArmed" | "agentsPaused" | "agentsPausedAt"> {
	return {
		planModeEnabled: state.planModeEnabled ?? false,
		prewalkArmed: state.prewalkArmed ?? false,
		agentsPaused: state.agentsPaused ?? false,
		agentsPausedAt: state.agentsPausedAt ?? null,
	};
}

export const createSessionStore = () =>
	createStore<SessionStore>()(set => ({
		...initialState,
		setSidecarError: (error, restart = null) =>
			set({ sidecarError: error, sidecarRestart: restart, sidecarDismissed: false }),
		clearSidecarError: () => set({ sidecarError: null, sidecarRestart: null, sidecarDismissed: false }),
		dismissSidecarBanner: () => set({ sidecarDismissed: true }),
		setSwitchPending: switchPending => set({ switchPending }),
		saveTranscriptView: transcriptView => set({ transcriptView }),
		pinTranscriptToBottom: () => set(state => ({ transcriptPinNonce: state.transcriptPinNonce + 1 })),
		setFromState: state =>
			set({
				sessionId: state.sessionId,
				// Sessions whose auto-title never ran carry an empty title slot on
				// disk; normalize "" to null so the TitleBar falls through to the
				// session-list title/first message instead of rendering blank.
				sessionName: state.sessionName || null,
				sessionFile: state.sessionFile ?? null,
				cwd: state.cwd,
				isStreaming: state.isStreaming,
				isCompacting: state.isCompacting,
				// The end events that clear these rows can be missed (the tab was
				// in the background); an idle snapshot proves the window closed.
				...(state.isStreaming ? {} : { retryInfo: null }),
				...(state.isCompacting ? {} : { compactionInfo: null }),
				contextUsage: state.contextUsage ?? null,
				messageCount: state.messageCount,
				queuedMessageCount: state.queuedMessageCount,
				...snapshotModeState(state),
			}),
		setStatus: (status, cwd) => set({ status, cwd }),
		reset: () => set(initialState),
	}));

const defaultSessionStore = createSessionStore();
export const useSessionStore = createScopedStoreHook("session", defaultSessionStore);
