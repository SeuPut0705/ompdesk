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
import { BotActivitySection } from "./BotActivity";
import { BotChannelRows } from "./BotChannels";
import { BotDutyRows } from "./BotDuties";
import { BotLibrarySection } from "./BotLibrary";
import { BotRoutineRows } from "./BotRoutines";
import { BotCompletedSection, BotTasksSection } from "./BotTasks";
import { BotTeachControl } from "./BotTeach";
import { nextWake } from "./bot-status";

export { BotBar } from "./BotBar";
export { BotCallBar } from "./BotCallBar";
export { BotDecisionDock } from "./BotDecisions";
export { AssistantText } from "./BotSources";
export { BotTakeoverBar } from "./BotTakeover";

/** What the bot works on now (its Tasks), placed right after the board's Now: the sessions it opened. */
export function BotBoardTasks({ tabId, device }: { tabId: string; device?: string }) {
	const t = useT();
	const { desk, loaded } = useBotDesk(device);
	return loaded ? (
		<BotTasksSection desk={desk} device={device} tabId={tabId} />
	) : (
		<BoardSection id="tasks" title={t("botHome.tasks.title")}>
			<li>
				<SkeletonRows label={t("botHome.loading")} widths={[70, 50, 40]} />
			</li>
		</BoardSection>
	);
}

/**
 * The rest of the bot's board, in the order the owner looks for it: what is scheduled (its routines, with Record a
 * workflow), what it delivered (Library), what it finished and did lately (Completed, Activity), then what it is
 * responsible for (its duties, which it keeps itself) and its side chats. Library, Completed and Duties are absent
 * while empty.
 */
export function BotBoardSections({ tabId, device }: { tabId: string; device?: string }) {
	const t = useT();
	const { desk, loaded } = useBotDesk(device);
	const wake = nextWake(desk.routines);
	const firstRoutine = (wake ? desk.routines.find(entry => entry.next === wake) : undefined) ?? desk.routines[0];
	return (
		<>
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
						<BotRoutineRows device={device} routines={desk.routines} />
						<li className="omp-work-board-item flex items-center py-1">
							<BotTeachControl device={device} />
						</li>
					</>
				) : (
					<li>
						<SkeletonRows label={t("botHome.loading")} widths={[55]} />
					</li>
				)}
			</BoardSection>
			<BotLibrarySection device={device} pins={desk.libraryPins} tabId={tabId} />
			{loaded && <BotCompletedSection desk={desk} device={device} tabId={tabId} />}
			<BotActivitySection channels={desk.channels} device={device} />
			{desk.duties.length > 0 && (
				<BoardSection
					count={desk.duties.length}
					id="duties"
					summary={{ lead: desk.duties[0]?.text ?? "", count: desk.duties.length }}
					title={t("botHome.duties.title")}
				>
					<BotDutyRows duties={desk.duties} />
				</BoardSection>
			)}
			<BoardSection
				count={desk.channels.length > 0 ? desk.channels.length : undefined}
				id="channels"
				summary={{
					lead: desk.channels[0]?.title ?? t("botChannels.none"),
					count: desk.channels.length > 0 ? desk.channels.length : undefined,
				}}
				title={t("botChannels.title")}
			>
				{loaded && <BotChannelRows channels={desk.channels} device={device} />}
			</BoardSection>
		</>
	);
}
