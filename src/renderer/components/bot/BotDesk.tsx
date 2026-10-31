/**
 * The bot's parts, one lazy chunk (`preloadBotDesk` in bot-tab.ts): its bar, its decisions above the composer and its
 * work board sections. The desk is main's (`stores/bot-desk.ts`); until the first read lands the board's sections are a
 * static skeleton, never a spinner.
 */
import { Check } from "lucide-react";
import type { BotDecision } from "../../../shared/bot-desk";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useBotDesk } from "../../stores/bot-desk";
import { SkeletonRows } from "../common";
import { BoardRow, BoardSection, CappedRows } from "../layout/work-board/board-parts";
import { BotDutyRows } from "./BotDuties";
import { BotWakeRows } from "./BotWakes";
import { nextWake } from "./bot-status";

export { BotBar } from "./BotBar";
export { BotDecisionDock } from "./BotDecisions";

/** The answered decisions the board lists before folding the rest. */
const PAST_CAP = 3;

type Answered = Extract<BotDecision, { state: "answered" }>;

/**
 * The bot's sections of its work board, after Needs you (as an Autopilot run's are): its standing duties, its scheduled
 * wakes and the decisions it was given, newest first. The sessions it opened are the board's own Now rows.
 */
export function BotBoardSections({ device }: { device?: string }) {
	const t = useT();
	const { desk, loaded } = useBotDesk(device);
	// Newest answer first: the last thing the owner decided is the one to check.
	const past = desk.decisions.filter((decision): decision is Answered => decision.state === "answered").toReversed();
	const wake = nextWake(desk.wakes);
	const firstWake = desk.wakes.find(entry => entry.next === wake);
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
			<BoardSection
				aside={wake ? formatClock(wake) : undefined}
				count={desk.wakes.length > 0 ? desk.wakes.length : undefined}
				id="wakes"
				summary={{
					lead: firstWake?.prompt.replace(/\s+/g, " ").trim() ?? t("botHome.wakes.empty"),
					count: desk.wakes.length > 0 ? desk.wakes.length : undefined,
				}}
				title={t("botHome.wakes.title")}
			>
				{loaded ? (
					<BotWakeRows wakes={desk.wakes} />
				) : (
					<li>
						<SkeletonRows label={t("botHome.loading")} widths={[55]} />
					</li>
				)}
			</BoardSection>
			{past.length > 0 && (
				<BoardSection
					count={past.length}
					id="decided"
					summary={{ lead: past[0]?.question ?? "", count: past.length }}
					title={t("botHome.decisions.past")}
				>
					<CappedRows cap={PAST_CAP} items={past}>
						{decision => (
							<BoardRow
								data={{ "data-bot-answered": decision.id }}
								key={decision.id}
								label={decision.question}
								lead={<Check aria-hidden className="size-3 text-(--sc-success)" />}
								meta={decision.answer}
								title={`${decision.question}\n${t("botHome.answered", { answer: decision.answer })}`}
							/>
						)}
					</CappedRows>
				</BoardSection>
			)}
		</>
	);
}
