/**
 * The toast for stock omp's `notice` frame. omp writes these sentences in English and has no UI language, so a notice
 * whose shape is known reads in the UI's words with omp's sentence kept as the toast's detail; an unknown one keeps
 * omp's sentence under a localized title naming its source.
 */
import type { AgentSessionEvent } from "../../shared/rpc-types";
import type { ToastInput } from "../stores/toast";
import { errorDetail } from "./error-detail";
import { translate } from "./i18n";
import { turnErrorToast } from "./messages";

type NoticeEvent = Extract<AgentSessionEvent, { type: "notice" }>;

/** Routine informational churn: vision/xdev mount notices fire on every model switch and need no action. */
const QUIET_SOURCES: Record<string, true> = { vision: true, xdev: true };

// Stock session/session-advisors.ts `notifyFailure` and `notifyQuotaExhausted`.
const ADVISOR_UNAVAILABLE = /^Advisor(?: "[^"]*")? unavailable for (\S+): ([\s\S]+)$/;
const ADVISOR_QUOTA = /^Advisor "[^"]*" quota exhausted/;

/** One rule per source whose warnings omp words in a known shape; `null` lets the generic toast through. */
const KNOWN: Record<string, (message: string) => Omit<ToastInput, "variant" | "detail"> | null> = {
	// A compaction failure reads like a failed turn; anything unrecognized keeps a localized title.
	compaction: message => {
		const failure = turnErrorToast(message);
		return failure.kind === "unknown"
			? { title: translate("events.compactionNotice"), message: translate("toast.failedRetry") }
			: { title: failure.title, message: failure.message };
	},
	advisor: message => {
		const unavailable = ADVISOR_UNAVAILABLE.exec(message);
		if (unavailable?.[1] && unavailable[2]) {
			return {
				title: translate("events.advisorUnavailable", { model: unavailable[1] }),
				message: translate("events.advisorUnavailableBody", { reason: turnErrorToast(unavailable[2]).title }),
			};
		}
		if (ADVISOR_QUOTA.test(message)) {
			return { title: translate("events.advisorQuota"), message: translate("events.advisorQuotaBody") };
		}
		return null;
	},
};

export function noticeToast(event: NoticeEvent): ToastInput | null {
	if (event.level === "info" && event.source && QUIET_SOURCES[event.source]) return null;
	const variant = event.level === "error" ? "error" : event.level === "warning" ? "warning" : "info";
	const known = variant !== "info" && event.source ? KNOWN[event.source]?.(event.message) : null;
	if (known) return { variant, ...known, detail: errorDetail(event.message) };
	return {
		variant,
		...(event.source ? { title: translate("events.noticeFrom", { source: event.source }) } : {}),
		message: event.message,
	};
}
