/**
 * The bot's decision inbox on its home: one card per open decision (the question, what the owner needs to know, one
 * Button per option and a free answer), then the answered ones folded under "Past decisions". Answering asks main
 * (`useBotDeskStore.answer`); the card leaves when main's change arrives, never before, so a refused answer stays.
 */
import { Check, Send } from "lucide-react";
import { useState } from "react";
import type { BotDecision } from "../../../shared/bot-desk";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { MarkdownRenderer } from "../../lib/markdown";
import { useBotDeskStore } from "../../stores/bot-desk";
import { Button, DisclosureButton, Input } from "../common";

/** Lists, headings, fences, quotes, emphasis, code spans and links: anything else reads best as the plain text it is. */
const MARKDOWN_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)|\*\*|`[^`\n]+`|\]\(/;

function DecisionContext({ text }: { text: string }) {
	return (
		<div className="max-h-48 overflow-y-auto text-sc-sm text-(--sc-text-secondary)" data-bot-decision-context>
			{MARKDOWN_HINT.test(text) ? (
				<MarkdownRenderer content={text} />
			) : (
				<p className="whitespace-pre-wrap">{text}</p>
			)}
		</div>
	);
}

function DecisionCard({ decision, device }: { decision: BotDecision; device?: string }) {
	const t = useT();
	const answer = useBotDeskStore(state => state.answer);
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState(false);
	const send = async (text: string) => {
		const value = text.trim();
		if (!value || pending) return;
		setPending(true);
		const ok = await answer(decision.id, value, device);
		// An accepted answer leaves with main's change; a refused one stays to try again.
		if (!ok) setPending(false);
	};
	return (
		<li
			className="flex flex-col gap-2 rounded-(--sc-radius-md) border border-(--sc-border) p-3"
			data-bot-decision={decision.id}
		>
			<div className="flex items-baseline justify-between gap-3">
				<p className="min-w-0 text-sc-md font-medium text-(--sc-text) [overflow-wrap:anywhere]">
					{decision.question}
				</p>
				<span className="shrink-0 text-sc-xs text-(--sc-text-subtle)">{formatClock(decision.at)}</span>
			</div>
			{decision.context ? <DecisionContext text={decision.context} /> : null}
			{decision.options.length > 0 ? (
				<div className="flex flex-wrap gap-2" data-bot-options>
					{decision.options.map(option => (
						<Button
							data-bot-option={option}
							disabled={pending}
							key={option}
							onClick={() => void send(option)}
							size="sm"
						>
							{option}
						</Button>
					))}
				</div>
			) : null}
			<div className="flex items-center gap-2">
				{/* The field's shell is the row's flex item: Input puts className on the inner element. */}
				<div className="min-w-0 flex-1">
					<Input
						aria-label={t("botHome.freeAnswer")}
						controlSize="sm"
						data-bot-answer-input
						disabled={pending}
						maxLength={2000}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") {
								event.preventDefault();
								void send(draft);
							}
						}}
						placeholder={t("botHome.freeAnswerPlaceholder")}
						value={draft}
					/>
				</div>
				<Button
					data-bot-answer-send
					disabled={pending || draft.trim() === ""}
					icon={<Send />}
					onClick={() => void send(draft)}
					size="sm"
				>
					{t("botHome.sendAnswer")}
				</Button>
			</div>
		</li>
	);
}

function AnsweredDecision({ decision }: { decision: Extract<BotDecision, { state: "answered" }> }) {
	const t = useT();
	return (
		<li className="flex flex-col gap-0.5 py-1.5" data-bot-answered={decision.id}>
			<p className="text-sc-sm text-(--sc-text-secondary) [overflow-wrap:anywhere]">{decision.question}</p>
			<p className="flex items-start gap-1.5 text-sc-xs text-(--sc-text-muted)">
				<Check aria-hidden className="mt-0.5 size-3 shrink-0 text-(--sc-success)" />
				<span className="min-w-0 [overflow-wrap:anywhere]">
					{t("botHome.answered", { answer: decision.answer })}
				</span>
			</p>
		</li>
	);
}

export function BotDecisions({ decisions, device }: { decisions: readonly BotDecision[]; device?: string }) {
	const t = useT();
	const [pastOpen, setPastOpen] = useState(false);
	const open = decisions.filter(decision => decision.state === "open");
	// Newest answer first: the last thing the owner decided is the one to check.
	const past = decisions.filter(decision => decision.state === "answered").toReversed();
	return (
		<div className="flex flex-col gap-3">
			{open.length === 0 ? (
				<p className="text-sc-sm text-(--sc-text-muted)" data-bot-decisions-empty>
					{t("botHome.decisions.empty")}
				</p>
			) : (
				<ul className="flex flex-col gap-3" data-bot-decisions>
					{open.map(decision => (
						<DecisionCard decision={decision} device={device} key={decision.id} />
					))}
				</ul>
			)}
			{past.length > 0 ? (
				<div className="flex flex-col" data-bot-past>
					<DisclosureButton
						className="h-(--sc-control-sm) text-sc-sm text-(--sc-text-secondary)"
						onToggle={() => setPastOpen(value => !value)}
						open={pastOpen}
					>
						{t("botHome.decisions.past", { count: past.length })}
					</DisclosureButton>
					{pastOpen ? (
						<ul className="flex flex-col pl-6">
							{past.map(decision =>
								decision.state === "answered" ? (
									<AnsweredDecision decision={decision} key={decision.id} />
								) : null,
							)}
						</ul>
					) : null}
				</div>
			) : null}
		</div>
	);
}
