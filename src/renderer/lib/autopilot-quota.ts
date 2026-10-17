/**
 * An Autopilot run that stops on the account's usage limit books its own resume (the same booking the turn error card
 * offers by hand: `stores/quota-resume.ts`, run by `hooks/use-quota-resume.ts` with stock `retry`). Nobody is at the
 * keyboard to press it, and a rate-limit stop leaves the Goal active with no turn to continue it.
 */
import type { AgentSessionEvent, UsageReport } from "../../shared/rpc-types";
import { isLiveAutopilot, useAutopilotStore } from "../stores/autopilot";
import type { ModelStore } from "../stores/model";
import { quotaResetAt, useQuotaResumeStore } from "../stores/quota-resume";
import type { SessionStore } from "../stores/session";
import { sessionRuntime, sessionRuntimeStore, withSessionRuntime } from "../stores/session-runtime-context";
import { describeTurnError } from "./messages";
import { createTabRpc } from "./tab-rpc";
import { readUsageReports } from "./usage-reports";

/** How long a rate-limit stop waits when no usage report names a reset (a short rate limit, or no report at all). */
export const QUOTA_FALLBACK_MS = 15 * 60_000;

/**
 * The time to book, or null when nothing should be booked: the stop is not a rate limit, the session is no live run,
 * it has no id yet, or a booking exists. The first account of the provider to reset frees the session.
 */
export function autopilotQuotaBooking(input: {
	live: boolean;
	sessionId: string;
	provider: string | undefined;
	booked: number | undefined;
	errorMessage: string | undefined;
	stopReason: string | undefined;
	reports: readonly UsageReport[] | null;
	now: number;
}): number | null {
	if (!input.live || !input.sessionId || input.booked !== undefined) return null;
	if (input.stopReason !== "error") return null;
	if (describeTurnError(input.errorMessage, input.stopReason).kind !== "rateLimit") return null;
	return quotaResetAt(input.reports ?? [], input.provider, input.now) ?? input.now + QUOTA_FALLBACK_MS;
}

/** Called at a tab's terminal `agent_end`: books the resume when an Autopilot run's turn ended on the usage limit. */
export async function bookAutopilotQuota(
	tabId: string,
	event: Extract<AgentSessionEvent, { type: "agent_end" }>,
): Promise<void> {
	if (event.isTerminal === false) return;
	const last = event.messages?.findLast(message => message.role === "assistant");
	if (last?.stopReason !== "error") return;
	const runtime = sessionRuntime(tabId);
	if (!runtime) return;
	const live = withSessionRuntime(tabId, () => isLiveAutopilot(useAutopilotStore.getState()));
	const sessionId = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId ?? "";
	const provider = sessionRuntimeStore<ModelStore>(tabId, "model")?.getState().model?.provider;
	const errorMessage = typeof last.errorMessage === "string" ? last.errorMessage : undefined;
	const common = { live, sessionId, provider, errorMessage, stopReason: last.stopReason };
	const booked = () => useQuotaResumeStore.getState().reservations[sessionId];
	// Cheap rejection first: only a rate-limit stop of a live run reads the usage reports.
	if (autopilotQuotaBooking({ ...common, booked: booked(), reports: [], now: 0 }) === null) return;
	let reports: UsageReport[] | null = null;
	try {
		const read = readUsageReports(await createTabRpc(runtime.command).getUsage());
		if (read.ok) reports = read.reports;
	} catch {
		// No report: the fallback wait books it.
	}
	if (sessionRuntime(tabId) !== runtime) return;
	const resetAt = autopilotQuotaBooking({ ...common, booked: booked(), reports, now: Date.now() });
	if (resetAt !== null) useQuotaResumeStore.getState().reserve(sessionId, resetAt);
}
