import type { AgentMessage } from "../../../../shared/rpc-types";
import { type RestartCut, type RestartCuts, restartCutsOf } from "../../../lib/restart-cuts";
import { useMessagesStore } from "../../../stores/messages";

/** The subagents a restart cut in this session's transcript, committed and live (`restartCuts` indexes it once). */
export function useRestartCuts(): RestartCuts {
	return useMessagesStore(state => restartCutsOf(state.messages, state.liveMessages));
}

const NO_CUTS: ReadonlyMap<string, RestartCut> = new Map();

/** The task jobs of one `async-result` message that a restart cut, by job id. */
export function useDeliveryCuts(message: AgentMessage): ReadonlyMap<string, RestartCut> {
	return useMessagesStore(
		state => restartCutsOf(state.messages, state.liveMessages).deliveries.get(message) ?? NO_CUTS,
	);
}
