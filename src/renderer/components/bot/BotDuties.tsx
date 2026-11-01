/**
 * The bot's standing duties as rows of its work board section, one line each. The bot keeps the list itself
 * (`ompdesk_bot duty_add`/`duty_remove`, as the owner tells it in chat): the owner reads it here and changes it by
 * telling the bot, as in ChatGPT dots, Grok Bot and Claude Duet, which give no duty editor.
 */
import { ListChecks } from "lucide-react";
import type { BotDuty } from "../../../shared/bot-desk";
import { BoardRow, CappedRows, KindMark } from "../layout/work-board/board-parts";

/** Rows the section lists before folding the rest into "+N more". */
const CAP = 5;

export function BotDutyRows({ duties }: { duties: readonly BotDuty[] }) {
	return (
		<CappedRows cap={CAP} items={duties}>
			{duty => (
				<BoardRow
					data={{ "data-bot-duty": duty.id }}
					key={duty.id}
					label={duty.text}
					lead={<KindMark icon={ListChecks} tone="muted" />}
					title={duty.text}
				/>
			)}
		</CappedRows>
	);
}
