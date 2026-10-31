/**
 * The bot's parts, one lazy chunk (`preloadBotDesk` in bot-tab.ts): its bar, its decisions above the composer and its
 * work board sections. The desk is main's (`stores/bot-desk.ts`); until the first read lands the board's sections are a
 * static skeleton, never a spinner.
 */
import { useT } from "../../lib/i18n";
import { useBotDesk } from "../../stores/bot-desk";
import { SkeletonRows } from "../common";
import { BoardSection } from "../layout/work-board/board-parts";
import { BotDutyRows } from "./BotDuties";
import { BotLibrarySection } from "./BotLibrary";
import { BotTasksSection } from "./BotTasks";

export { BotBar } from "./BotBar";
export { BotDecisionDock } from "./BotDecisions";

/**
 * The bot's sections of its work board, after Needs you (as an Autopilot run's are): its standing duties (what it keeps
 * doing, editable: Muse's Goals), its Tasks (in progress, scheduled, completed) and its Library (what its work made).
 */
export function BotBoardSections({ tabId, device }: { tabId: string; device?: string }) {
	const t = useT();
	const { desk, loaded } = useBotDesk(device);
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
			<BotLibrarySection device={device} pins={desk.libraryPins} tabId={tabId} />
		</>
	);
}
