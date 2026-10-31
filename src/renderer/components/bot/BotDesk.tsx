/**
 * The bot's parts, one lazy chunk (`preloadBotDesk` in bot-tab.ts): its bar, its decisions above the composer and its
 * work board sections. The desk is main's (`stores/bot-desk.ts`); until the first read lands the board's sections are a
 * static skeleton, never a spinner.
 */
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useBotDesk } from "../../stores/bot-desk";
import { SkeletonRows } from "../common";
import { BoardSection } from "../layout/work-board/board-parts";
import { BotDutyRows } from "./BotDuties";
import { BotLibrarySection } from "./BotLibrary";
import { BotRoutineRows } from "./BotRoutines";
import { BotTasksSection } from "./BotTasks";
import { BotTeachControl } from "./BotTeach";
import { nextWake } from "./bot-status";

export { BotBar } from "./BotBar";
export { BotDecisionDock } from "./BotDecisions";

/**
 * The bot's sections of its work board, after Needs you (as an Autopilot run's are): its standing duties (what it keeps
 * doing, editable: Muse's Goals), its Tasks (in progress, scheduled, completed), its routines (what starts it on a
 * clock or an event, with their runs, and Record a workflow) and its Library (what its work made).
 */
export function BotBoardSections({ tabId, device }: { tabId: string; device?: string }) {
	const t = useT();
	const { desk, loaded } = useBotDesk(device);
	const wake = nextWake(desk.routines);
	const firstRoutine = (wake ? desk.routines.find(entry => entry.next === wake) : undefined) ?? desk.routines[0];
	return (
		<>
			<BoardSection
				count={desk.duties.length > 0 ? desk.duties.length : undefined}
				id="duties"
				summary={{
					lead: desk.duties[0]?.text ?? t("botHome.duties.none"),
					count: desk.duties.length > 0 ? desk.duties.length : undefined,
				}}
				title={t("botHome.duties.title")}
			>
				{loaded ? (
					<BotDutyRows device={device} duties={desk.duties} />
				) : (
					<li>
						<SkeletonRows label={t("botHome.loading")} widths={[60, 45]} />
					</li>
				)}
			</BoardSection>
			{loaded ? (
				<BotTasksSection desk={desk} device={device} tabId={tabId} />
			) : (
				<BoardSection id="tasks" title={t("botHome.tasks.title")}>
					<li>
						<SkeletonRows label={t("botHome.loading")} widths={[70, 50, 40]} />
					</li>
				</BoardSection>
			)}
			<BoardSection
				aside={wake ? formatClock(wake) : undefined}
				count={desk.routines.length > 0 ? desk.routines.length : undefined}
				id="routines"
				summary={{
					lead: firstRoutine?.name ?? t("botHome.routines.empty"),
					count: desk.routines.length > 0 ? desk.routines.length : undefined,
				}}
				title={t("botHome.routines.title")}
			>
				{loaded ? (
					<>
						<li className="omp-work-board-item flex items-center py-1">
							<BotTeachControl device={device} />
						</li>
						<BotRoutineRows device={device} routines={desk.routines} />
					</>
				) : (
					<li>
						<SkeletonRows label={t("botHome.loading")} widths={[55]} />
					</li>
				)}
			</BoardSection>
			<BotLibrarySection device={device} pins={desk.libraryPins} tabId={tabId} />
		</>
	);
}
