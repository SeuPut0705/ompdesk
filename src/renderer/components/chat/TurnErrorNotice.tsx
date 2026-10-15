import { Ban } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { UsageReport } from "../../../shared/rpc-types";
import { hydrateSession, hydrateTabSession } from "../../hooks/use-rpc-events";
import { formatClock, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { describeTurnError, retryLastTurn, runManualMaintenance, type TurnErrorAction } from "../../lib/messages";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { useLiveUsage } from "../../lib/usage-reports";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { quotaResetAt, useQuotaResumeStore } from "../../stores/quota-resume";
import { useSessionStore } from "../../stores/session";
import { sessionRuntime, useRuntimeTabId } from "../../stores/session-runtime-context";
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
	const [pending, setPending] = useState<TurnErrorAction | null>(null);
	const description = describeTurnError(errorMessage, stopReason);
	const latest = useMessagesStore(state => timestamp !== undefined && state.messages.at(-1)?.timestamp === timestamp);
	const quota = description.kind === "rateLimit" && latest;
	const provider = useModelStore(state => state.model?.provider);
	const sessionId = useSessionStore(state => state.sessionId);
	const booked = useQuotaResumeStore(state => (sessionId ? state.reservations[sessionId] : undefined));
	const [resetAt, setResetAt] = useState<number>();
	const now = useNowTick(quota && (resetAt !== undefined || booked !== undefined));

	/** Best effort: without a usage report the card keeps its plain guidance. */
	const readReset = useCallback(async (): Promise<boolean> => {
		const response = await rpc.getUsage();
		if (!response.success) return false;
		const data: unknown = response.data;
		const reports: UsageReport[] =
			typeof data === "object" && data !== null && "reports" in data && Array.isArray(data.reports)
				? data.reports
				: [];
		setResetAt(quotaResetAt(reports, provider, Date.now()));
		return true;
	}, [rpc, provider]);
	useEffect(() => {
		if (quota) void readReset().catch(() => undefined);
	}, [quota, readReset]);
	// The reset moves when another account frees up or a reset pass is spent.
	useLiveUsage(readReset, quota);

	if (description.kind === "aborted") {
		return (
			<p className="omp-turn-stopped mt-2 flex items-center gap-1.5 text-sc-sm text-(--sc-text-muted)">
				<Ban aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				{t("turnError.aborted.title")}
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
			toast({ variant: "success", title: t("command.compactedTitle"), message: t("command.compactedMessage") });
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
	return (
		<Banner
			actions={[
				...description.actions.map((action, index) => (
					<Button
						disabled={pending !== null && pending !== action}
						key={action}
						loading={pending === action}
						onClick={() => void run(action)}
						size="sm"
						variant={index === 0 ? "secondary" : "ghost"}
					>
						{t(ACTION_LABEL_KEYS[action])}
					</Button>
				)),
				showReset && sessionId ? (
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
