/**
 * The composer's side of the automatic mode choice (Plan or Goal only; rules in
 * resources/gui-bridge/auto-mode-core.ts). Called just before a typed prompt is sent: when the pref is on and no
 * mode is active, asks the tab's omp (`auto_mode_decide`; the host's for a paired host's tab) and mirrors the
 * result in the session store, which shows the "Auto: Plan" chip. It never throws and never waits longer than the
 * decision's own deadline plus a margin: a failure is "none" and the prompt goes out unchanged.
 */

import type { StoreApi } from "zustand";
import {
	AUTO_MODE_PREF,
	AUTO_MODE_TIMEOUT_MS,
	type AutoModeDecision,
	autoModeFromPref,
} from "../../../resources/gui-bridge/auto-mode-contracts";
import { autoModeSkip } from "../../../resources/gui-bridge/auto-mode-core";
import type { SessionStore } from "../stores/session";
import type { TabRpc } from "./tab-rpc";

/** The transport may add a little to the host's own 1.5 s deadline before the prompt stops waiting. */
const CLIENT_DEADLINE_MS = AUTO_MODE_TIMEOUT_MS + 1000;

export function goalIsActive(state: Pick<SessionStore, "goal" | "goalState">): boolean {
	return state.goalState?.status === "active" || state.goalState?.status === "paused" || !!state.goal;
}

export async function runAutoMode(input: {
	message: string;
	isStreaming: boolean;
	session: StoreApi<SessionStore>;
	rpc: Pick<TabRpc, "autoModeDecide">;
	readPref?: () => Promise<unknown>;
}): Promise<AutoModeDecision | null> {
	const { message, isStreaming, session, rpc } = input;
	try {
		const enabled = autoModeFromPref(await (input.readPref ?? (() => window.omp.prefs.get(AUTO_MODE_PREF)))());
		const state = session.getState();
		const loop = state.loopMode?.enabled === true;
		const skip = autoModeSkip({
			text: message,
			enabled,
			streaming: isStreaming,
			active: { plan: state.planModeEnabled, goal: goalIsActive(state), loop, vibe: state.vibeModeEnabled },
			suppressed: false,
		});
		if (skip) return null;
		const origin = state.sessionId;
		const response = await Promise.race([
			rpc.autoModeDecide(message, { loop }),
			new Promise<null>(resolve => setTimeout(() => resolve(null), CLIENT_DEADLINE_MS)),
		]);
		if (!response?.success) return null;
		const decision = response.data as AutoModeDecision | undefined;
		if (!decision || session.getState().sessionId !== origin) return null;
		if (decision.mode === "plan") {
			session.setState({ planModeEnabled: true, autoMode: "plan" });
		} else if (decision.mode === "goal") {
			session.setState({
				goal: { objective: decision.objective },
				goalState: { status: "active" },
				autoMode: "goal",
			});
		}
		return decision;
	} catch {
		return null;
	}
}
