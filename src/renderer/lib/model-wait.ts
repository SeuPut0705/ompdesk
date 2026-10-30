/**
 * The working cue's words for a model call whose request went out and has no answer yet ("Waiting for the model's
 * response · 2m" instead of "Thinking…"). Why (28-29 Oct 2026, this Mac): turns sat on "Thinking…" for up to 14
 * minutes while the request waited on a broken connection; the turn-stages log showed the wait was the provider's
 * answer, never the model thinking. The bridge sends `model_request` `sent`/`answered` for the main loop's own
 * requests (turn-stages.ts), the messages store's turn meter keeps `modelWaitSince`, and this names it once it has
 * lasted as long as the log's own late mark: a normal answer comes in seconds, so a fast call never flashes the words.
 */
import { LATE_FIRST_OUTPUT_MS } from "../../../resources/gui-bridge/turn-stages-contracts";
import { useMessagesStore } from "../stores/messages";
import { useModelWaitTogetherStore } from "../stores/model-wait-together";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { formatSpan } from "./format";
import { useT } from "./i18n";
import { useNowTick } from "./now-tick";

/** The wait is named from this long on (the turn-stages log's late first output). */
export const MODEL_WAIT_SHOWN_MS = LATE_FIRST_OUTPUT_MS;

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function modelWaitText(since: number | null, now: number, t: Translate, together = 0): string | null {
	if (since === null || now - since < MODEL_WAIT_SHOWN_MS) return null;
	const time = formatSpan(now - since);
	// Two or more sessions waiting on one provider: the wait is the provider's queue, not this session.
	return together >= 2
		? t("chat.awaitingModel.together", { time, count: together })
		: t("chat.awaitingModel.wait", { time });
}

/** The tab's model wait in words, or null; ticks on the shared clock only while a request waits. */
export function useModelWait(): string | null {
	const since = useMessagesStore(state => state.turnMeter.modelWaitSince);
	const now = useNowTick(since !== null);
	const tabId = useRuntimeTabId();
	const together = useModelWaitTogetherStore(state => (tabId ? (state.tabs[tabId] ?? 0) : 0));
	return modelWaitText(since, now, useT(), together);
}
