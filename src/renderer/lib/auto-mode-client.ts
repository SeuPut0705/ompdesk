/**
 * The composer's side of the automatic mode choice (Plan or Goal only; rules in
 * resources/gui-bridge/modes/auto-mode-core.ts). Called just before a typed prompt is sent: when the pref is on and no
 * mode is active, asks the tab's omp (`auto_mode_decide`; the host's for a paired host's tab) and mirrors the
 * result in the session store, which shows the "This request: Plan" chip. It never throws and never waits longer than
 * the decision's own deadline plus a margin: a failure is "none" and the prompt goes out unchanged.
 *
 * A decision is used for one request only, never as the session's mode (the Mode picker leaves it out): an automatic
 * plan still on when the user sends something that is not a reply to it (no proposal awaits approval) is ended
 * first, through stock's own exit (`auto_mode_end`), and an automatic goal ends when the user stops the turn
 * (`endAutoGoal`), when it completes, or with the chip's undo.
 */

import type { StoreApi } from "zustand";
import {
	AUTO_MODE_PREF,
	AUTO_MODE_TIMEOUT_MS,
	type AutoModeDecision,
	autoModeFromPref,
} from "../../../resources/gui-bridge/modes/auto-mode-contracts";
import { autoModeSkip } from "../../../resources/gui-bridge/modes/auto-mode-core";
import type { SessionStore } from "../stores/session";
import type { TabRpc } from "./tab-rpc";

/** The transport may add a little to the host's own 2 s deadline before the prompt stops waiting. */
const CLIENT_DEADLINE_MS = AUTO_MODE_TIMEOUT_MS + 1000;

export function goalIsActive(state: Pick<SessionStore, "goal" | "goalState">): boolean {
	return state.goalState?.status === "active" || state.goalState?.status === "paused" || !!state.goal;
}

/** End the automatic plan the previous request used; false when it could not be ended (it then stays the mode). */
export async function endAutoPlan(session: StoreApi<SessionStore>, rpc: Pick<TabRpc, "autoModeEnd">): Promise<boolean> {
	const origin = session.getState().sessionId;
	const response = await rpc.autoModeEnd("plan");
	if (!response.success) return false;
	if (session.getState().sessionId === origin) session.setState({ planModeEnabled: false, autoMode: null });
	return true;
}

/** The user stopped the turn of an automatic goal: the goal ends with it, never staying as the session's mode. */
export async function endAutoGoal(session: StoreApi<SessionStore>, rpc: Pick<TabRpc, "autoModeEnd">): Promise<void> {
	if (session.getState().autoMode !== "goal") return;
	const origin = session.getState().sessionId;
	try {
		const response = await rpc.autoModeEnd("goal");
		if (response.success && session.getState().sessionId === origin) {
			session.setState({ goal: null, goalState: null, autoMode: null });
		}
	} catch {
		// The goal stays; its chip's undo still ends it.
	}
}

export interface RunAutoModeInput {
	message: string;
	isStreaming: boolean;
	session: StoreApi<SessionStore>;
	rpc: Pick<TabRpc, "autoModeDecide" | "autoModeEnd">;
	/** A plan proposal awaits approval: a message now is a reply to that plan. */
	planPending?: boolean;
	readPref?: () => Promise<unknown>;
	/**
	 * The user withdrew the prompt (Stop or Esc) while the choice was being asked: the call returns at once with
	 * no decision. The host may still answer later and has by then applied it (a plan, a goal): that late answer is
	 * ended through `onLateDecision`.
	 */
	signal?: AbortSignal;
	/** A decision that landed after `signal` aborted: the mode it started must end (default: through `autoModeEnd`). */
	onLateDecision?: (decision: AutoModeDecision) => void;
	/** The choice is being asked (true) or is over, answered, timed out or withdrawn (false): for the "deciding" cue. */
	onDeciding?: (deciding: boolean) => void;
}

const ABORTED = Symbol("withdrawn");

export async function runAutoMode(input: RunAutoModeInput): Promise<AutoModeDecision | null> {
	const { message, isStreaming, session, rpc, signal } = input;
	let deciding = false;
	try {
		const before = session.getState();
		if (!isStreaming && before.autoMode === "plan" && before.planModeEnabled && !input.planPending) {
			if (!(await endAutoPlan(session, rpc))) return null;
		}
		const enabled = autoModeFromPref(await (input.readPref ?? (() => window.omp.prefs.get(AUTO_MODE_PREF)))());
		const state = session.getState();
		const skip = autoModeSkip({
			text: message,
			enabled,
			streaming: isStreaming,
			active: {
				plan: state.planModeEnabled,
				goal: goalIsActive(state),
			},
			suppressed: false,
		});
		if (skip || signal?.aborted) return null;
		const origin = state.sessionId;
		deciding = true;
		input.onDeciding?.(true);
		const request = rpc.autoModeDecide(message);
		const response = await Promise.race([
			request,
			new Promise<null>(resolve => setTimeout(() => resolve(null), CLIENT_DEADLINE_MS)),
			new Promise<typeof ABORTED>(resolve =>
				signal?.addEventListener("abort", () => resolve(ABORTED), { once: true }),
			),
		]);
		if (response === ABORTED) {
			// Return now; the decision, if the host still makes one, is undone when it lands.
			void request.then(
				late => {
					const decision = late.success ? (late.data as AutoModeDecision | undefined) : undefined;
					if (decision?.mode !== "plan" && decision?.mode !== "goal") return;
					if (input.onLateDecision) input.onLateDecision(decision);
					else void rpc.autoModeEnd(decision.mode).catch(() => {});
				},
				() => {},
			);
			return null;
		}
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
	} finally {
		if (deciding) input.onDeciding?.(false);
	}
}
