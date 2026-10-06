import { Ban } from "lucide-react";
import { useState } from "react";
import { hydrateSession, hydrateTabSession } from "../../hooks/use-rpc-events";
import { useT } from "../../lib/i18n";
import { describeTurnError, retryLastTurn, type TurnErrorAction } from "../../lib/messages";
import { useTabRpc } from "../../lib/tab-rpc";
import { sessionRuntime, useRuntimeTabId } from "../../stores/session-runtime-context";
import { toast } from "../../stores/toast";
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
 */
export function TurnErrorNotice({ errorMessage, stopReason }: { errorMessage?: string; stopReason?: string }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const [pending, setPending] = useState<TurnErrorAction | null>(null);
	const description = describeTurnError(errorMessage, stopReason);

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
			const response = await rpc.compact();
			if (!response.success) throw new Error(response.error);
			await (tabId && sessionRuntime(tabId) ? hydrateTabSession(tabId) : hydrateSession());
			toast({ variant: "success", title: t("command.compactedTitle"), message: t("command.compactedMessage") });
		} catch (cause) {
			toast({
				variant: "error",
				title: t(action === "retry" ? "turnError.retryFailed" : "modelPicker.compactFailed"),
				message: cause instanceof Error ? cause.message : String(cause),
			});
		} finally {
			setPending(null);
		}
	};

	return (
		<Banner
			actions={description.actions.map((action, index) => (
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
			))}
			className="omp-message-error mt-3 flex-wrap"
			title={t(description.titleKey)}
			variant="danger"
		>
			<p>{t(description.guidanceKey)}</p>
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
