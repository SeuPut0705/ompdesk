/**
 * The bot's decision inbox, docked above its pane's composer while any decision is open: one entry per open decision
 * (the question, what the owner needs to know, one Button per option and a free answer) in a dock card the owner can
 * fold to one line. Answering asks main (`useBotDeskStore.answer`); the entry leaves when main's change arrives, never
 * before, so a refused answer stays. The answered ones are the work board's "Past decisions" (`BotBoardSections`).
 */
import { Inbox, Send } from "lucide-react";
import { useState } from "react";
import { type BotDecision, openBotDecisions } from "../../../shared/bot-desk";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { MarkdownRenderer } from "../../lib/markdown";
import { useBotDesk, useBotDeskStore } from "../../stores/bot-desk";
import { DockCard } from "../chat/dock/DockCard";
import { Badge, Button, InlineNotice, Input } from "../common";

/** Lists, headings, fences, quotes, emphasis, code spans and links: anything else reads best as the plain text it is. */
const MARKDOWN_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)|\*\*|`[^`\n]+`|\]\(/;

function DecisionContext({ text }: { text: string }) {
	return (
		<div className="max-h-32 overflow-y-auto text-sc-sm text-(--sc-text-secondary)" data-bot-decision-context>
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
		<li className="flex flex-col gap-2 px-3 py-3" data-bot-decision={decision.id}>
			<div className="flex items-baseline justify-between gap-3">
				<p className="min-w-0 text-sc-md font-medium text-(--sc-text) [overflow-wrap:anywhere]">
					{decision.question}
				</p>
				<span className="shrink-0 text-sc-xs text-(--sc-text-subtle) tabular-nums">{formatClock(decision.at)}</span>
			</div>
			{decision.context ? <DecisionContext text={decision.context} /> : null}
			<div className="flex flex-wrap items-center gap-2">
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
				{/* The field's shell is the row's flex item: Input puts className on the inner element. */}
				<div className="flex min-w-48 flex-1 items-center gap-2">
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
			</div>
		</li>
	);
}

/** The open decisions above the composer, in the transcript's column; nothing while none is open. */
export function BotDecisionDock({ device }: { device?: string }) {
	const t = useT();
	const { desk, loaded, loadError } = useBotDesk(device);
	const refresh = useBotDeskStore(state => state.refresh);
	const open = openBotDecisions(desk);
	if (!loaded && loadError)
		return (
			<div className="omp-bot-column shrink-0 pt-2" data-bot-decisions-dock>
				<div className="omp-composer-shell">
					<InlineNotice
						action={
							<Button onClick={() => void refresh(device)} size="sm">
								{t("common.retry")}
							</Button>
						}
						detail={loadError}
						title={t("botHome.loadFailed")}
						tone="danger"
					/>
				</div>
			</div>
		);
	if (open.length === 0) return null;
	return (
		<div className="omp-bot-column shrink-0 pt-2" data-bot-decisions-dock>
			<div className="omp-composer-shell">
				<DockCard
					badge={<Badge variant="warning">{open.length}</Badge>}
					icon={Inbox}
					id="decisions"
					peek={<span className="truncate">{open[0]?.question}</span>}
					title={t("botHome.decisions.title")}
				>
					{/* A long inbox scrolls in place: the composer and the transcript's foot stay on screen. */}
					<ul
						className="flex max-h-[min(40dvh,320px)] flex-col divide-y divide-(--sc-border-subtle) overflow-y-auto overscroll-contain"
						data-bot-decisions
					>
						{open.map(decision => (
							<DecisionCard decision={decision} device={device} key={decision.id} />
						))}
					</ul>
				</DockCard>
			</div>
		</div>
	);
}
