import { Ban, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { quotaResetAt } from "../../../shared/quota-reset";
import { hydrateSession, hydrateTabSession } from "../../hooks/use-rpc-events";
import { useUsageReports } from "../../hooks/use-usage-reports";
import { formatClock, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { describeTurnError, retryLastTurn, runManualMaintenance, type TurnErrorAction } from "../../lib/messages";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { isLiveAutopilot, useAutopilotStore } from "../../stores/autopilot";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useQuotaResumeStore } from "../../stores/quota-resume";
import { useSessionStore } from "../../stores/session";
import { sessionRuntime, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useAwaitingConnection, useScheduledRetry } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Banner, Button } from "../common";

const ACTION_LABEL_KEYS: Record<TurnErrorAction, string> = {
	retry: "turnError.action.retry",
	changeModel: "turnError.action.changeModel",
	openProviders: "turnError.action.openProviders",
	compact: "turnError.action.compact",
};

/**
 * How a failed or stopped assistant turn ends in the transcript. A user stop
 * is a neutral one-line "Stopped" note, never an error. Every other failure is
 * an inline danger card that says what happened and what to do, in the user's
 * language, with the recovery actions that fit (retry, change model, open
 * providers, compact context); the raw provider text stays behind a disclosure.
 * The session's latest turn stopped by a usage limit also names when the
 * provider's limit resets and can book the turn to resume then.
 */
export function TurnErrorNotice({
	errorMessage,
	stopReason,
	timestamp,
}: {
	errorMessage?: string;
	stopReason?: string;
	/** The failed message's timestamp: the reset time shows only on the session's latest turn. */
	timestamp?: string | number;
}) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const awaitingConnection = useAwaitingConnection();
	const retrying = useSessionStore(state => state.retryInfo !== null);
	const [pending, setPending] = useState<TurnErrorAction | null>(null);
	const description = describeTurnError(errorMessage, stopReason);
	// A run's messages stay live (uncommitted) until its terminal end, and stock's retry saga is one run:
	// its failed attempts are live messages, so both checks read the live tail before the committed one.
	const latest = useMessagesStore(
		state => timestamp !== undefined && (state.liveMessages.at(-1) ?? state.messages.at(-1))?.timestamp === timestamp,
	);
	// The turn went on after this failure without a new prompt (stock's auto-retry, Retry, the
	// connection wait's retry, a restore): the failure is history, not the turn's outcome.
	const retried = useMessagesStore(state => {
		if (timestamp === undefined) return false;
		let answeredSince = false;
		for (const list of [state.liveMessages, state.messages])
			for (let index = list.length - 1; index >= 0; index--) {
				const message = list[index];
				if (message?.timestamp === timestamp && message.role === "assistant") return answeredSince;
				if (message?.role === "user") answeredSince = false;
				else if (message?.role === "assistant") answeredSince = true;
			}
		return false;
	});
	const quota = description.kind === "rateLimit" && latest;
	const provider = useModelStore(state => state.model?.provider);
	const sessionId = useSessionStore(state => state.sessionId);
	const booked = useQuotaResumeStore(state => (sessionId ? state.reservations[sessionId] : undefined));
	// An Autopilot run waits for the quota on its own (main's `waiting_quota`): no second booking to offer.
	const autopilotRun = useAutopilotStore(isLiveAutopilot);
	// Best effort: without a usage report the card keeps its plain guidance. The reset moves when another
	// account frees up or a reset pass is spent, so it follows the tab's live usage.
	const reports = useUsageReports(quota);
	const resetAt = useMemo(
		() => (reports ? quotaResetAt(reports, provider, Date.now()) : undefined),
		[reports, provider],
	);
	// main's backoff retry of this failed turn (turn-resume.ts): counted down on the card of the latest failure only.
	const scheduled = useScheduledRetry();
	const retryArmed = scheduled !== null && latest;
	const now = useNowTick((quota && (resetAt !== undefined || booked !== undefined)) || retryArmed);

	if (description.kind === "aborted") {
		return (
			<p className="omp-turn-stopped mt-2 flex items-center gap-1.5 text-sc-sm text-(--sc-text-muted)">
				<Ban aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				{t("turnError.aborted.title")}
			</p>
		);
	}

	// Waiting for the connection is not a failure: the status row says so and main continues the turn.
	if (awaitingConnection !== null && latest) return null;
	// Nor is a failure stock's own auto-retry is still working on: the status row shows the attempt with its Stop.
	// A red card with "Try again" beside it reads as a dead turn while the retry is still on, and a Stop then ends it for good.
	if (retrying && latest) return null;

	if (retried) {
		return (
			<p
				className="omp-turn-retried mt-2 flex items-center gap-1.5 text-sc-sm text-(--sc-text-muted)"
				data-turn-retried
			>
				<RotateCcw aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				{t("turnError.retried", { title: t(description.titleKey) })}
			</p>
		);
	}

	const run = async (action: TurnErrorAction) => {
		if (action === "changeModel") {
			useUiStore.getState().openModelPicker();
			return;
		}
		if (action === "openProviders") {
			useUiStore.getState().openProviders();
			return;
		}
		setPending(action);
		try {
			if (action === "retry") {
				const onEmpty = () =>
					toast({ variant: "warning", title: t("palette.retryNothing"), message: t("palette.retryNothingDesc") });
				await retryLastTurn(onEmpty, rpc, tabId);
				return;
			}
			const { response, cancelled } = await runManualMaintenance("compact", () => rpc.compact(), tabId);
			if (cancelled) {
				toast({ variant: "info", message: t("command.compactCancelled") });
				return;
			}
			if (!response.success) throw new Error(response.error);
			await (tabId && sessionRuntime(tabId) ? hydrateTabSession(tabId) : hydrateSession());
			toast({ variant: "success", message: t("command.compactedTitle") });
		} catch (cause) {
			toastError({
				title: t(action === "retry" ? "turnError.retryFailed" : "modelPicker.compactFailed"),
				error: cause,
			});
		} finally {
			setPending(null);
		}
	};

	const resumeAt = booked ?? resetAt;
	const showReset = quota && resumeAt !== undefined && resumeAt > now;
	// "Retry now" stands in for "Try again" while main waits to retry on its own.
	const actions = retryArmed ? description.actions.filter(action => action !== "retry") : description.actions;
	const retrySeconds = scheduled ? Math.max(0, Math.ceil((scheduled.at - now) / 1000)) : 0;
	return (
		<Banner
			actions={[
				retryArmed ? (
					<Button
						data-scheduled-retry-now
						key="retry-now"
						loading={pending === "retry"}
						disabled={pending !== null && pending !== "retry"}
						onClick={() => void run("retry")}
						size="sm"
						variant="secondary"
					>
						{t("turnError.scheduled.now")}
					</Button>
				) : null,
				retryArmed && scheduled ? (
					<Button
						data-scheduled-retry-cancel
						disabled={pending !== null}
						key="retry-cancel"
						onClick={() =>
							void window.omp.resume
								.cancelWait(scheduled.tabId)
								.catch((cause: unknown) =>
									toastError({ title: t("chat.connectionWaitCancelFailed"), error: cause }),
								)
						}
						size="sm"
						variant="ghost"
					>
						{t("common.cancel")}
					</Button>
				) : null,
				...actions.map((action, index) => (
					<Button
						disabled={pending !== null && pending !== action}
						key={action}
						loading={pending === action}
						onClick={() => void run(action)}
						size="sm"
						variant={index === 0 && !retryArmed ? "secondary" : "ghost"}
					>
						{t(ACTION_LABEL_KEYS[action])}
					</Button>
				)),
				showReset && sessionId && !autopilotRun ? (
					<Button
						data-quota-resume={booked !== undefined ? "booked" : "offer"}
						key="resume"
						onClick={() =>
							booked !== undefined
								? useQuotaResumeStore.getState().cancel(sessionId)
								: useQuotaResumeStore.getState().reserve(sessionId, resumeAt)
						}
						size="sm"
						variant="ghost"
					>
						{booked !== undefined
							? t("turnError.resume.cancel")
							: t("turnError.resume.book", { time: formatClock(resumeAt) })}
					</Button>
				) : null,
			]}
			className="omp-message-error mt-3 flex-wrap"
			title={t(description.titleKey)}
			variant="danger"
		>
			<p>{t(description.guidanceKey)}</p>
			{retryArmed && scheduled ? (
				<p className="omp-scheduled-retry tabular-nums" data-scheduled-retry>
					{t("turnError.scheduled.countdown", {
						countdown: `${Math.floor(retrySeconds / 60)}:${String(retrySeconds % 60).padStart(2, "0")}`,
					})}
					<span className="text-(--sc-text-muted)">
						{" · "}
						{t("turnError.scheduled.attempt", { attempt: scheduled.attempt, max: scheduled.max })}
					</span>
				</p>
			) : null}
			{showReset ? (
				<p className="omp-quota-reset tabular-nums" data-quota-reset>
					{t(booked !== undefined ? "turnError.resume.booked" : "turnError.resume.resetsAt", {
						time: formatClock(resumeAt),
						countdown: formatDuration(resumeAt - now),
					})}
				</p>
			) : null}
			{description.detail ? (
				<details className="omp-message-error-detail mt-1.5">
					<summary className="cursor-pointer text-sc-sm text-(--sc-text-muted) hover:text-(--sc-text)">
						{t("turnError.details")}
					</summary>
					<pre className="mt-1.5 max-h-40 overflow-auto font-mono text-sc-xs break-words whitespace-pre-wrap text-(--sc-text-secondary)">
						{description.detail}
					</pre>
				</details>
			) : null}
		</Banner>
	);
}
