/**
 * The bot's standing duties on its home: the list with a remove button on each and one field to add (Enter adds).
 * Every edit writes the whole list (`setDuties`), the way main stores it; the list changes when main's change arrives.
 */
import { ListChecks, Plus, X } from "lucide-react";
import { useState } from "react";
import { BOT_DUTIES_MAX, BOT_DUTY_TEXT_MAX, type BotDuty } from "../../../shared/bot-desk";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useBotDeskStore } from "../../stores/bot-desk";
import { Button, IconButton, Input } from "../common";
import { BoardRow, KindMark } from "../layout/work-board/board-parts";

export function BotDuties({ duties, device }: { duties: readonly BotDuty[]; device?: string }) {
	const t = useT();
	const setDuties = useBotDeskStore(state => state.setDuties);
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState(false);
	const full = duties.length >= BOT_DUTIES_MAX;
	const write = async (next: { id?: string; text: string }[]): Promise<boolean> => {
		setPending(true);
		const ok = await setDuties(next, device);
		setPending(false);
		return ok;
	};
	const kept = duties.map(({ id, text }) => ({ id, text }));
	const add = async () => {
		const text = draft.trim();
		if (!text || full || pending) return;
		if (await write([...kept, { text }])) setDraft("");
	};
	return (
		<div className="flex flex-col gap-2">
			{duties.length === 0 ? (
				<p className="text-sc-sm text-(--sc-text-muted)" data-bot-duties-empty>
					{t("botHome.duties.empty")}
				</p>
			) : (
				<ul className="omp-work-board-list" data-bot-duties>
					{duties.map(duty => (
						<BoardRow
							action={
								<IconButton
									data-bot-duty-remove={duty.id}
									disabled={pending}
									icon={<X />}
									label={t("botHome.duties.remove", { text: duty.text })}
									onClick={() => void write(kept.filter(entry => entry.id !== duty.id))}
									size="sm"
								/>
							}
							data={{ "data-bot-duty": duty.id }}
							key={duty.id}
							label={<span className="whitespace-normal [overflow-wrap:anywhere]">{duty.text}</span>}
							lead={<KindMark icon={ListChecks} tone="muted" />}
							title={duty.text}
						/>
					))}
				</ul>
			)}
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<Input
						aria-label={t("botHome.duties.add")}
						controlSize="sm"
						data-bot-duty-input
						disabled={full || pending}
						maxLength={BOT_DUTY_TEXT_MAX}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") {
								event.preventDefault();
								void add();
							}
						}}
						placeholder={full ? t("botHome.duties.full") : t("botHome.duties.placeholder")}
						value={draft}
					/>
				</div>
				<Button
					data-bot-duty-add
					disabled={full || pending || draft.trim() === ""}
					icon={<Plus />}
					onClick={() => void add()}
					size="sm"
				>
					{t("botHome.duties.addButton")}
				</Button>
			</div>
		</div>
	);
}
