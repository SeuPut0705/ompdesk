import { Pause, Pencil, Play, Target, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTabGuard } from "../../../hooks/use-tab-guard";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useSessionStore } from "../../../stores/session";
import { toast } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { IconButton, Spinner } from "../../common";

type GoalAction = "pause" | "resume" | "drop";

/** Compact, persistent control strip for the session's active goal. */
export function GoalDockBar() {
	const t = useT();
	const rpc = useTabRpc();
	const goal = useSessionStore(state => state.goal);
	const goalState = useSessionStore(state => state.goalState);
	const openModes = useUiStore(state => state.openModes);
	const [busy, setBusy] = useState<GoalAction | null>(null);
	const { capture, isActive } = useTabGuard();

	if (!goal) return null;

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
				toast({ variant: "error", title: t("dock.goal.actionFailed"), message: response.error });
				return;
			}
			if (action === "drop") useSessionStore.setState({ goal: null, goalState: null });
			else useSessionStore.setState({ goalState: { status: action === "pause" ? "paused" : "active" } });
		} catch (cause) {
			if (!isActive(origin)) return;
			toast({ variant: "error", title: t("dock.goal.actionFailed"), message: String(cause) });
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="flex min-w-0 items-center gap-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) py-1.5 pr-1.5 pl-3">
			<Target aria-hidden="true" className="shrink-0 text-(--sc-text-muted)" size={16} />
			<span className="shrink-0 text-sc-md font-medium text-(--sc-text)">
				{paused ? t("dock.goal.paused") : t("dock.goal.active")}
			</span>
			<span className="min-w-0 flex-1 truncate text-sc-md text-(--sc-text-secondary)" title={objective}>
				{objective}
			</span>
			<IconButton
				disabled={busy !== null}
				icon={
					busy === "pause" || busy === "resume" ? (
						<Spinner inheritColor size="sm" />
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
				icon={busy === "drop" ? <Spinner inheritColor size="sm" /> : <Trash2 />}
				label={t("modesPanel.goal.drop")}
				onClick={() => void runAction("drop")}
				size="sm"
			/>
		</div>
	);
}
