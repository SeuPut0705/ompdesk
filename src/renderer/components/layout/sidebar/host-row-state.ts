/**
 * What a paired host's session shows on this computer's sidebar: its row's run state and what a folded section of that
 * host counts. Pure, so a host's row, its folded header and a session opened on it under its opener read one rule.
 */
import type { HostLiveSession, HostView } from "../../../../shared/ipc-types";
import type { AskKind } from "../../../lib/attention";
import { tabSignalPresentation } from "../../../lib/tab-signal";
import type { SessionTab } from "../../../stores/tabs";
import { type FoldSignal, type FoldSummary, foldSummary, sessionFoldSignal } from "./fold-summary";

/**
 * A host row's run state, the one rule its row, a session opened on it under its opener and the folded headers read.
 * Two sources, either one enough: a tab here (unless restored asleep at launch, which has heard nothing yet) says what
 * this computer heard of the run, and the host's own live list says what the host runs now (a tab here can miss a
 * turn's start: the row read "Open" while the host ran it). The live list only says that a prompt waits (a question,
 * as on the row). `fold` is what a folded header counts of it (`fold-summary.ts`; a host row shows no ✓ for an unseen
 * finish).
 */
export function hostRowState(tab: SessionTab | undefined, live: HostLiveSession["state"] | undefined) {
	const known = tab?.status === "asleep" ? undefined : tab;
	const signal = known ? tabSignalPresentation(known) : null;
	const asked = known?.awaitingInput ?? (live === "waiting" ? "input" : undefined);
	const ask: AskKind | undefined = asked && (asked === "approval" ? "approval" : "question");
	const waiting = ask !== undefined;
	const tabRuns = signal?.running === true;
	const running = !waiting && (tabRuns || live === "turn" || live === "background");
	const settling = tabRuns ? known?.settling === true : live === "background";
	const fold = sessionFoldSignal({ waiting: ask, running, done: false });
	return { known, signal, ask, waiting, running, settling, fold };
}

/**
 * A folded host section's summary, read without its list (a folded host's list is not read): this computer's tabs on
 * it and the host's live list, each session once, by the rows' rule. A session a session here opened there is that
 * opener's child (`nested`), counted in this computer's section.
 */
export function hostSectionSummary(
	host: Pick<HostView, "deviceId" | "live">,
	tabs: readonly SessionTab[],
	nested: ReadonlySet<string> | undefined,
): FoldSummary {
	const live = new Map(host.live?.map(session => [session.sessionPath, session.state]));
	const signals: (FoldSignal | null)[] = [];
	const seen = new Set<string>();
	for (const tab of tabs) {
		if (tab.device !== host.deviceId || nested?.has(tab.id)) continue;
		if (tab.sessionPath) seen.add(tab.sessionPath);
		signals.push(hostRowState(tab, tab.sessionPath ? live.get(tab.sessionPath) : undefined).fold);
	}
	for (const [path, state] of live)
		if (!seen.has(path) && !nested?.has(path)) signals.push(hostRowState(undefined, state).fold);
	return foldSummary(signals);
}
