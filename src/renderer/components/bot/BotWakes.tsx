/**
 * The bot's own scheduled wakes (`ompdesk_schedule {"target":"self"}`) as rows of its work board section: the prompt
 * it wakes with and its next start, one line each; the whole prompt is the tooltip.
 */
import { AlarmClock } from "lucide-react";
import type { BotWake } from "../../../shared/bot-desk";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { BoardRow, KindMark } from "../layout/work-board/board-parts";

export function BotWakeRows({ wakes }: { wakes: readonly BotWake[] }) {
	const t = useT();
	if (wakes.length === 0)
		return (
			<li className="omp-work-board-more" data-bot-wakes-empty>
				{t("botHome.wakes.empty")}
			</li>
		);
	return wakes.map(wake => (
		<BoardRow
			data={{ "data-bot-wake": wake.id }}
			key={wake.id}
			label={wake.prompt.replace(/\s+/g, " ").trim()}
			lead={<KindMark icon={AlarmClock} tone={wake.next === null ? "muted" : "info"} />}
			meta={wake.next === null ? t("botHome.wakes.paused") : formatClock(wake.next)}
			title={wake.prompt}
		/>
	));
}
