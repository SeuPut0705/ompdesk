/**
 * The bot's own scheduled wakes on its home (`ompdesk_schedule {"target":"self"}`): the next start and the prompt it
 * wakes with, one line each; the whole prompt is the tooltip.
 */
import { AlarmClock } from "lucide-react";
import type { BotWake } from "../../../shared/bot-desk";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { BoardRow, KindMark } from "../layout/work-board/board-parts";

export function BotWakes({ wakes }: { wakes: readonly BotWake[] }) {
	const t = useT();
	if (wakes.length === 0)
		return (
			<p className="text-sc-sm text-(--sc-text-muted)" data-bot-wakes-empty>
				{t("botHome.wakes.empty")}
			</p>
		);
	return (
		<ul className="omp-work-board-list" data-bot-wakes>
			{wakes.map(wake => (
				<BoardRow
					data={{ "data-bot-wake": wake.id }}
					key={wake.id}
					label={wake.prompt.replace(/\s+/g, " ").trim()}
					lead={<KindMark icon={AlarmClock} tone="muted" />}
					meta={wake.next === null ? t("botHome.wakes.paused") : formatClock(wake.next)}
					title={wake.prompt}
				/>
			))}
		</ul>
	);
}
