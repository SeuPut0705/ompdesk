import { PanelRight, Rocket } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { useUiStore } from "../../../stores/ui";
import { IconButton } from "../../common";
import { useAutopilotStateText } from "./AutopilotBoardCard";
import { AutopilotStopButtons } from "./AutopilotControls";

/**
 * What the dock shows for a Goal that is an Autopilot run, in place of the plain Goal strip (whose pause, edit and
 * drop would fight the coordinator): the run's state, the way to its screen, and the two stops.
 */
export function AutopilotDockRow({ inline = false }: { inline?: boolean }) {
	const t = useT();
	const text = useAutopilotStateText();
	return (
		<div
			className={
				inline
					? "omp-work-context-row flex min-w-0 items-center gap-2"
					: "flex min-w-0 items-center gap-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) py-1.5 pr-1.5 pl-3"
			}
			data-autopilot-dock
			data-goal-row={inline || undefined}
		>
			<Rocket aria-hidden="true" className="shrink-0 text-(--sc-text-muted)" size={inline ? 14 : 16} />
			<span className="shrink-0 text-sc-md font-medium text-(--sc-text)">{t("autopilot.name")}</span>
			<span className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text-muted)">{text}</span>
			<IconButton
				icon={<PanelRight />}
				label={t("autopilot.chip.open")}
				onClick={() => useUiStore.getState().openAutopilotPanel()}
				size="sm"
			/>
			<AutopilotStopButtons />
		</div>
	);
}
