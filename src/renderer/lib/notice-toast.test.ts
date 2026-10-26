import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { noticeToast } from "./notice-toast";

// Stock omp writes its notices in English (session/session-advisors.ts, session-maintenance.ts); the toast speaks the
// UI's language and keeps omp's sentence as its detail.
describe("noticeToast", () => {
	it("says an advisor the provider turned away in the UI's words, the provider's sentence kept as detail", () => {
		// 26 Oct 2026, the user's report: this sentence was the whole toast, titled "advisor".
		const message =
			"Advisor unavailable for openai-codex/gpt-6-astra: Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded)";
		const toast = noticeToast({ type: "notice", level: "warning", message, source: "advisor" });
		expect(toast).toEqual({
			variant: "warning",
			title: translate("events.advisorUnavailable", { model: "openai-codex/gpt-6-astra" }),
			message: translate("events.advisorUnavailableBody", { reason: translate("turnError.rateLimit.title") }),
			detail: message,
		});
	});

	it("names a named advisor and an unrecognized cause without the provider's English", () => {
		const message = 'Advisor "reviewer" unavailable for anthropic/claude-x: unexpected token in advisor frame';
		const toast = noticeToast({ type: "notice", level: "warning", message, source: "advisor" });
		expect(toast?.title).toBe(translate("events.advisorUnavailable", { model: "anthropic/claude-x" }));
		expect(toast?.message).toBe(
			translate("events.advisorUnavailableBody", { reason: translate("turnError.unknown.title") }),
		);
		expect(toast?.detail).toBe(message);
	});

	it("says an advisor's quota ran out", () => {
		const message = 'Advisor "default" quota exhausted — pausing until reset.';
		expect(noticeToast({ type: "notice", level: "warning", message, source: "advisor" })).toEqual({
			variant: "warning",
			title: translate("events.advisorQuota"),
			message: translate("events.advisorQuotaBody"),
			detail: message,
		});
	});

	it("keeps a compaction failure's humanized copy", () => {
		const toast = noticeToast({
			type: "notice",
			level: "warning",
			message: "compaction failed: 429 Too Many Requests",
			source: "compaction",
		});
		expect(toast?.title).toBe(translate("turnError.compaction.title"));
		expect(toast?.detail).toBe("compaction failed: 429 Too Many Requests");
	});

	it("titles a notice it does not know by its source in the UI's words and keeps omp's sentence", () => {
		const toast = noticeToast({ type: "notice", level: "warning", message: "Something new from omp", source: "lsp" });
		expect(toast).toEqual({
			variant: "warning",
			title: translate("events.noticeFrom", { source: "lsp" }),
			message: "Something new from omp",
		});
	});

	it("drops routine mount churn and lets an unknown advisor shape through untouched", () => {
		expect(noticeToast({ type: "notice", level: "info", message: "mounted", source: "vision" })).toBeNull();
		expect(
			noticeToast({ type: "notice", level: "info", message: "Advisor started", source: "advisor" })?.message,
		).toBe("Advisor started");
	});
});
