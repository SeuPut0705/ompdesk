/**
 * The bot's parts, one lazy chunk (`preloadBotDesk` in bot-tab.ts): its bar, its decisions above the composer and its
 * work board sections. The desk is main's (`stores/bot-desk.ts`); until the first read lands the board's sections are a
 * static skeleton, never a spinner.
 */
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { botDisplayName } from "../../lib/session-title";
import { useBotDesk } from "../../stores/bot-desk";
import { useSessionStore } from "../../stores/session";
import { SkeletonRows } from "../common";
import { BoardSection } from "../layout/work-board/board-parts";
import { BotActivityRows } from "./BotActivity";
import { BotChannelRows } from "./BotChannels";
import { BotDutyRows } from "./BotDuties";
import { BotLibrarySection } from "./BotLibrary";
import { BotMemoryActions, BotMemoryRows } from "./BotMemory";
import { BotRoutineRows } from "./BotRoutines";
import { BotTasksSection } from "./BotTasks";
import { BotTeachControl } from "./BotTeach";
import { nextWake } from "./bot-status";

export { BotBar } from "./BotBar";
export { BotCallBar } from "./BotCallBar";
export { BotDecisionDock } from "./BotDecisions";
export { AssistantText } from "./BotSources";

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
	// The tab's own omp holds the bot's name (its session's title); Memory.md is headed by it.
	const sessionName = useSessionStore(state => state.sessionName);
	const name = botDisplayName({ title: sessionName ?? "" }, t("sidebar.botBadge"));
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
			<BoardSection
				action={<BotMemoryActions device={device} memories={desk.memories} name={name} />}
				count={desk.memories.length > 0 ? desk.memories.length : undefined}
				id="memory"
				summary={{
					lead: desk.memories.at(-1)?.text ?? t("botMemory.none"),
					count: desk.memories.length > 0 ? desk.memories.length : undefined,
				}}
				title={t("botMemory.title")}
			>
				{loaded ? (
					<BotMemoryRows device={device} memories={desk.memories} />
				) : (
					<li>
						<SkeletonRows label={t("botHome.loading")} widths={[60, 45]} />
					</li>
				)}
			</BoardSection>
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
			<BoardSection id="activity" summary={{ lead: t("botActivity.title") }} title={t("botActivity.title")}>
				<BotActivityRows channels={desk.channels} device={device} />
			</BoardSection>
		</>
	);
}
