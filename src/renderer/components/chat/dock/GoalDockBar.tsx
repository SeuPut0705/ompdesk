import { Pause, Pencil, Play, Target, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTabGuard } from "../../../hooks/use-tab-guard";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { isLiveAutopilot, useAutopilotStore } from "../../../stores/autopilot";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { IconButton, Spinner } from "../../common";
import { AutopilotDockRow } from "../../panels/autopilot/AutopilotDockRow";

type GoalAction = "pause" | "resume" | "drop";

/**
 * Compact, persistent control strip for the session's active goal. `inline`
 * drops the dock chrome for use as a row inside the running work card.
 */
export function GoalDockBar({ inline = false }: { inline?: boolean }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const sessionStore = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
	const goal = useSessionStore(state => state.goal);
	const goalState = useSessionStore(state => state.goalState);
	const openModes = useUiStore(state => state.openModes);
	const [busy, setBusy] = useState<GoalAction | null>(null);
	const { capture, isActive } = useTabGuard();
	// Stock goals have no "blocked" status; a question or plan waiting on the user is that state.
	const questionPending = useExtensionUiStore(state =>
		state.pendingRequests.some(request => isUserBlockingRequest(state, request)),
	);
	const planPending = usePlanApprovalStore(state => state.pending !== null);
	const autopilot = useAutopilotStore(isLiveAutopilot);
	const needsAnswer = questionPending || planPending;

	if (!goal) return null;
	// An Autopilot run is a Goal underneath; its own strip replaces this one (pausing or dropping here would fight it).
	if (autopilot) return <AutopilotDockRow inline={inline} />;

	const paused = goalState?.status === "paused";
	const objective = goal.objective?.trim() || t("input.goal.label");

	const runAction = async (action: GoalAction) => {
		if (busy) return;
		const origin = capture();
		if (!origin) return;
		setBusy(action);

		try {
			const response = await rpc.setGoal({ action });
			if (!isActive(origin)) return;
			if (!response.success) {
				toastError({ title: t("dock.goal.actionFailed"), error: response });
				return;
			}
			if (action === "drop") sessionStore.setState({ goal: null, goalState: null });
			else sessionStore.setState({ goalState: { status: action === "pause" ? "paused" : "active" } });
		} catch (cause) {
			if (!isActive(origin)) return;
			toastError({ title: t("dock.goal.actionFailed"), error: cause });
		} finally {
			setBusy(null);
		}
	};

	return (
		<div
			className={
				inline
					? "omp-work-context-row flex min-w-0 items-center gap-2"
					: "flex min-w-0 items-center gap-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) py-1.5 pr-1.5 pl-3"
			}
			data-goal-row={inline || undefined}
		>
			<Target aria-hidden="true" className="shrink-0 text-(--sc-text-muted)" size={inline ? 14 : 16} />
			<span
				className={
					inline
						? "shrink-0 text-sc-sm text-(--sc-text-muted)"
						: "shrink-0 text-sc-md font-medium text-(--sc-text)"
				}
			>
				{paused ? t("dock.goal.paused") : t("dock.goal.active")}
			</span>
			{needsAnswer && !paused && (
				<span
					className="shrink-0 rounded-(--sc-radius-full) bg-(--sc-warning-soft) px-1.5 text-sc-xs text-(--sc-warning)"
					data-goal-needs-answer
				>
					{t("dock.goal.needsAnswer")}
				</span>
			)}
			<span
				className={
					inline
						? "min-w-0 flex-1 truncate text-sc-sm text-(--sc-text)"
						: "min-w-0 flex-1 truncate text-sc-md text-(--sc-text-secondary)"
				}
				title={objective}
			>
				{objective}
			</span>
			<IconButton
				disabled={busy !== null}
				icon={
					busy === "pause" || busy === "resume" ? (
						<Spinner inheritColor size="sm" spin />
					) : paused ? (
						<Play />
					) : (
						<Pause />
					)
				}
				label={paused ? t("modesPanel.goal.resume") : t("modesPanel.goal.pause")}
				onClick={() => void runAction(paused ? "resume" : "pause")}
				size="sm"
			/>
			<IconButton
				disabled={busy !== null}
				icon={<Pencil />}
				label={t("dock.goal.edit")}
				onClick={() => openModes("goal")}
				size="sm"
			/>
			<IconButton
				className="hover:text-(--sc-danger)"
				disabled={busy !== null}
				icon={<Trash2 />}
				label={t("modesPanel.goal.drop")}
				loading={busy === "drop"}
				onClick={() => void runAction("drop")}
				size="sm"
			/>
		</div>
	);
}
