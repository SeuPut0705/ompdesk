/**
 * The bot's decision inbox, docked above its pane's composer while any decision is open: one entry per open decision
 * in a dock card the owner can fold to one line. An entry shows what is asked and, when the answer approves an
 * action, that exact operation and its inputs; the bot's notes behind "See details"; a draft the owner may edit before
 * answering (it goes back with the answer); how long the answer still counts ("Expires in 8 min", then "Expired",
 * when nothing more can be sent); one Button per option and a free answer. Answering asks main
 * (`useBotDeskStore.answer`); the entry leaves when main's change arrives, never before, so a refused answer stays.
 * Answered ones are the work board's Activity (`BotBoardSections`).
 */
import { Clock, Inbox, Send } from "lucide-react";
import { useRef, useState } from "react";
import { type BotDecision, decisionExpired } from "../../../shared/bot-desk";
import { useListMotion } from "../../hooks/use-list-motion";
import { usePresence } from "../../hooks/use-presence";
import { formatClock, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { MarkdownRenderer } from "../../lib/markdown";
import { useNowTick } from "../../lib/now-tick";
import { useBotDesk, useBotDeskStore, useOpenBotDecisions } from "../../stores/bot-desk";
import { useTabsStore } from "../../stores/tabs";
import { DockCard } from "../chat/dock/DockCard";
import { Badge, Button, DisclosureButton, InlineNotice, Input, TextArea } from "../common";
import { LiveBotAvatar } from "./BotAvatar";
import { botState, tabBotFacts } from "./bot-status";
import { useBotTab } from "./bot-tab";

/** Lists, headings, fences, quotes, emphasis, code spans and links: anything else reads best as the plain text it is. */
const MARKDOWN_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)|\*\*|`[^`\n]+`|\]\(/;
/** A Markdown picture (`![A: …](/abs/path.png)`): the owner sees it before answering, never folded or clipped. */
const PICTURE = /!\[[^\]\n]*\]\(/;

function DecisionContext({ text }: { text: string }) {
	return (
		<div
			className={`${PICTURE.test(text) ? "" : "max-h-32 overflow-y-auto "}text-sc-sm text-(--sc-text-secondary)`}
			data-bot-decision-context
		>
			{MARKDOWN_HINT.test(text) ? (
				<MarkdownRenderer content={text} />
			) : (
				<p className="whitespace-pre-wrap">{text}</p>
			)}
		</div>
	);
}

/** The exact operation, verbatim, and its inputs by name. */
function DecisionOperation({ decision }: { decision: BotDecision }) {
	const t = useT();
	const inputs = Object.entries(decision.inputs ?? {});
	if (!decision.operation && inputs.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-2) px-3 py-2">
			{decision.operation ? (
				<pre
					aria-label={t("botHome.operation")}
					className="max-h-32 overflow-y-auto font-mono text-sc-sm break-words whitespace-pre-wrap text-(--sc-text)"
					data-bot-decision-operation
				>
					{decision.operation}
				</pre>
			) : null}
			{inputs.length > 0 ? (
				<dl
					aria-label={t("botHome.inputs")}
					className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sc-sm"
					data-bot-decision-inputs
				>
					{inputs.map(([name, value]) => (
						<div className="contents" key={name}>
							<dt className="truncate text-(--sc-text-muted)">{name}</dt>
							<dd className="min-w-0 font-mono [overflow-wrap:anywhere] text-(--sc-text)">{value}</dd>
						</div>
					))}
				</dl>
			) : null}
		</div>
	);
}

/** "Expires in 8 min" while the answer still counts, "Expired" after; ticks only for a decision that expires. */
function useExpiry(decision: BotDecision): { expired: boolean; left: number | null } {
	const expiring = decision.expiresAt !== undefined;
	const now = useNowTick(expiring);
	if (!expiring) return { expired: false, left: null };
	return { expired: decisionExpired(decision, now), left: Date.parse(decision.expiresAt ?? "") - now };
}

function DecisionCard({
	decision,
	device,
	exiting = false,
}: {
	decision: BotDecision;
	device?: string;
	/** Answered or lapsed: kept for its exit, out of the tab order and the screen reader. */
	exiting?: boolean;
}) {
	const t = useT();
	const answer = useBotDeskStore(state => state.answer);
	const [freeText, setFreeText] = useState("");
	const [draft, setDraft] = useState(decision.draft);
	const [details, setDetails] = useState(false);
	const [pending, setPending] = useState(false);
	const { expired, left } = useExpiry(decision);
	const locked = pending || expired;
	const send = async (text: string) => {
		const value = text.trim();
		if (!value || locked) return;
		setPending(true);
		// The draft as the owner left it travels with the answer; an untouched one is the bot's own.
		const edited = draft !== undefined && draft !== decision.draft ? draft : undefined;
		const ok = await answer(decision.id, value, device, edited);
		// An accepted answer leaves with main's change; a refused one stays to try again.
		if (!ok) setPending(false);
	};
	// With an operation or a draft to look at, the bot's notes wait behind "See details"; alone or with pictures they show.
	const tucked =
		decision.context !== undefined &&
		!PICTURE.test(decision.context) &&
		(decision.operation !== undefined || decision.draft !== undefined);
	return (
		<li
			aria-hidden={exiting || undefined}
			className={`flex flex-col gap-2 px-3 py-3 data-expired:opacity-70${exiting ? " omp-fade-out" : ""}`}
			data-bot-decision={decision.id}
			data-expired={expired || undefined}
			data-flip-key={decision.id}
			inert={exiting}
		>
			<div className="flex items-baseline justify-between gap-3">
				<p className="min-w-0 text-sc-md font-medium text-(--sc-text) [overflow-wrap:anywhere]">
					{decision.question}
				</p>
				<span className="flex shrink-0 items-center gap-2 text-sc-xs text-(--sc-text-subtle) tabular-nums">
					{left !== null ? (
						<span
							className={expired ? "text-(--sc-danger)" : "text-(--sc-warning)"}
							data-bot-decision-expiry={expired ? "expired" : "open"}
						>
							<Clock aria-hidden className="me-1 inline size-3 align-[-0.125em]" />
							{expired ? t("botHome.expired") : t("botHome.expiresIn", { time: formatDuration(left) })}
						</span>
					) : null}
					{formatClock(decision.at)}
				</span>
			</div>
			<DecisionOperation decision={decision} />
			{decision.draft !== undefined ? (
				<TextArea
					autoGrow
					data-bot-decision-draft
					disabled={locked}
					label={t("botHome.draft")}
					maxLength={8000}
					onChange={event => setDraft(event.target.value)}
					rows={3}
					value={draft ?? ""}
				/>
			) : null}
			{decision.context && tucked ? (
				<div className="flex flex-col gap-1">
					<DisclosureButton
						className="h-(--sc-control-sm) self-start text-sc-sm text-(--sc-text-secondary)"
						data-bot-decision-details
						onToggle={() => setDetails(value => !value)}
						open={details}
					>
						{t("botHome.details")}
					</DisclosureButton>
					{details ? <DecisionContext text={decision.context} /> : null}
				</div>
			) : decision.context ? (
				<DecisionContext text={decision.context} />
			) : null}
			<div className="flex flex-wrap items-center gap-2">
				{decision.options.map(option => (
					<Button
						data-bot-option={option}
						disabled={locked}
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
							disabled={locked}
							maxLength={2000}
							onChange={event => setFreeText(event.target.value)}
							onKeyDown={event => {
								if (isImeKeyEvent(event)) return;
								if (event.key === "Enter") {
									event.preventDefault();
									void send(freeText);
								}
							}}
							placeholder={t("botHome.freeAnswerPlaceholder")}
							value={freeText}
						/>
					</div>
					<Button
						data-bot-answer-send
						disabled={locked || freeText.trim() === ""}
						icon={<Send />}
						onClick={() => void send(freeText)}
						size="sm"
					>
						{t("botHome.sendAnswer")}
					</Button>
				</div>
			</div>
		</li>
	);
}

/**
 * The open decisions above the composer, in the transcript's column; nothing while none is open. A decision arriving
 * rises into the list and the others make room (`useListMotion`); one answered or lapsed fades out (`usePresence`),
 * and the dock itself with its last one.
 */
export function BotDecisionDock({ device }: { device?: string }) {
	const t = useT();
	const { desk, loaded, loadError } = useBotDesk(device);
	const refresh = useBotDeskStore(state => state.refresh);
	const open = useOpenBotDecisions(device);
	const bot = useBotTab();
	const state = botState(tabBotFacts(useTabsStore(store => store.tabs.find(tab => tab.id === bot?.tabId))));
	const presented = usePresence(open, decision => decision.id);
	const list = useRef<HTMLUListElement>(null);
	useListMotion(list, { enter: true });
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
	if (presented.length === 0) return null;
	// Every decision is on its way out: the dock fades as one piece, so the rows do not fade inside a fading card.
	const leaving = open.length === 0;
	const lead = (open[0] ?? presented[0]?.item)?.question;
	return (
		<div
			aria-hidden={leaving || undefined}
			className={`omp-bot-column shrink-0 pt-2${leaving ? " omp-fade-out" : ""}`}
			data-bot-decisions-dock
			inert={leaving}
		>
			<div className="omp-composer-shell">
				<DockCard
					actions={
						bot ? (
							<LiveBotAvatar
								avatar={desk.identity.avatar}
								data-bot-decisions-avatar
								device={device}
								size="inline"
								state={state}
								tabId={bot.tabId}
							/>
						) : undefined
					}
					badge={<Badge variant="warning">{leaving ? presented.length : open.length}</Badge>}
					icon={Inbox}
					id="decisions"
					peek={<span className="truncate">{lead}</span>}
					title={t("botHome.decisions.title")}
				>
					{/* A long inbox scrolls in place: the composer and the transcript's foot stay on screen. */}
					<ul
						className="flex max-h-[min(40dvh,320px)] flex-col divide-y divide-(--sc-border-subtle) overflow-y-auto overscroll-contain"
						data-bot-decisions
						ref={list}
					>
						{presented.map(({ item, exiting }) => (
							<DecisionCard decision={item} device={device} exiting={exiting && !leaving} key={item.id} />
						))}
					</ul>
				</DockCard>
			</div>
		</div>
	);
}
