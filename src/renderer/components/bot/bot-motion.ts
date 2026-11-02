/**
 * How the bot's avatar moves: one word per state it can show, chosen by the same facts everywhere the avatar draws
 * (the sidebar's two bot rows, the bar, the decision dock, Settings' preview). A reconnecting link outranks speaking
 * (a voice call on a lost link says nothing), which outranks the state `bot-status.ts` names. `BotAvatar.tsx` draws each.
 */
import type { RemoteLinkState } from "../../../shared/ipc-types";
import { useBotCallStore } from "../../stores/bot-call";
import { useRemoteStore } from "../../stores/remote";
import type { BotState } from "./bot-status";

export type BotMotion = BotState | "speaking" | "reconnecting";

export interface BotMotionFacts {
	state: BotState;
	/** The paired host's link; absent for this computer's bot. */
	link?: RemoteLinkState;
	/** The call's reply plays. */
	speaking: boolean;
}

/** Overrides in order; the first that answers wins, and no answer leaves the state's own motion. */
const OVERRIDES: ReadonlyArray<(facts: BotMotionFacts) => BotMotion | null> = [
	({ link }) => (link === "connecting" || link === "offline" ? "reconnecting" : null),
	({ speaking }) => (speaking ? "speaking" : null),
];

export function botMotion(facts: BotMotionFacts): BotMotion {
	for (const override of OVERRIDES) {
		const motion = override(facts);
		if (motion !== null) return motion;
	}
	return facts.state;
}

/** The motion of a bot's avatar: `device` is the paired host the bot lives on, `tabId` the tab a voice call may run on. */
export function useBotMotion({
	state,
	device,
	tabId,
}: {
	state: BotState;
	device?: string;
	tabId?: string;
}): BotMotion {
	const link = useRemoteStore(store =>
		device === undefined ? undefined : store.state?.hosts.find(host => host.deviceId === device)?.state,
	);
	const speaking = useBotCallStore(store => tabId !== undefined && store.tabId === tabId && store.speaking);
	return botMotion({ state, link, speaking });
}
