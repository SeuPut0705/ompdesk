/**
 * What the bot is doing, in the four words its row and its bar both say: one rule, read by `Sidebar.tsx` (tooltip)
 * and `BotBar.tsx`. Pure.
 */
import type { BotRoutine } from "../../../shared/bot-desk";
import { isSessionDown } from "../../lib/tab-signal";
import type { SessionTab } from "../../stores/tabs";

export type BotState = "idle" | "working" | "waiting" | "asleep";

export interface BotFacts {
	/** Some tab (here, another window, a paired device's) holds the session: it is up or coming up. */
	open: boolean;
	/** Its omp is not running: a restored tab not spawned yet, one waiting for omp, or one that failed. */
	asleep: boolean;
	/** Its own prompt (a question or an approval) waits on the owner. */
	waiting: boolean;
	running: boolean;
}

/** A closed or asleep bot is started by the next mail it gets: asleep. Its own prompt outranks its run. */
export function botState(facts: BotFacts): BotState {
	if (!facts.open || facts.asleep) return "asleep";
	if (facts.waiting) return "waiting";
	return facts.running ? "working" : "idle";
}

/** The facts of the tab that holds the bot's session; no tab at all is a closed bot. */
export function tabBotFacts(tab: Pick<SessionTab, "status" | "compacting" | "awaitingInput"> | undefined): BotFacts {
	if (!tab) return { open: false, asleep: true, waiting: false, running: false };
	const down = isSessionDown(tab);
	return {
		open: true,
		asleep: tab.status === "asleep" || tab.status === "waiting" || down,
		waiting: tab.awaitingInput !== undefined && !down,
		running: tab.status === "running" || tab.compacting === true,
	};
}

export function botStateKey(state: BotState): string {
	return `botHome.state.${state}`;
}

/** The earliest next start among the bot's routines (ISO), or null when none has one. */
export function nextWake(routines: readonly BotRoutine[]): string | null {
	let best: { iso: string; at: number } | null = null;
	for (const routine of routines) {
		const at = routine.next === null ? Number.NaN : Date.parse(routine.next);
		if (Number.isNaN(at)) continue;
		if (best === null || at < best.at) best = { iso: routine.next as string, at };
	}
	return best?.iso ?? null;
}
