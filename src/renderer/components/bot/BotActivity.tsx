/**
 * The bot's activity log (Muse's Activity log, Grok's audit log) as a section of its work board: what the bot and the
 * owner did, newest first. A filter keeps the changes, what it read and visited (`ompdesk_bot visited`'s list), or the
 * permissions (questions it put to the owner, approvals it gave its sessions, the owner's rule changes). A change that
 * can be taken back has Undo, once (`BOT_DESK_EDIT {op:"undo"}`); the rest says nothing, as a command run or a message
 * sent cannot be unsent. Read on demand while the board shows it (`stores/bot-activity.ts`).
 */
import {
	BellRing,
	BookOpen,
	CalendarClock,
	FilePen,
	type LucideIcon,
	MessagesSquare,
	NotebookPen,
	ShieldCheck,
	SquareTerminal,
	Undo2,
	Wrench,
} from "lucide-react";
import { useState } from "react";
import type { BotActivity, BotActivityKind } from "../../../shared/bot-activity";
import type { BotChannel } from "../../../shared/bot-desk";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useBotActivity } from "../../stores/bot-activity";
import { useBotDeskStore } from "../../stores/bot-desk";
import { Badge, Button, InlineNotice, Select, SkeletonRows } from "../common";
import { BoardRow, CappedRows, KindMark } from "../layout/work-board/board-parts";

const KIND_ICON: Record<BotActivityKind, LucideIcon> = {
	read: BookOpen,
	change: FilePen,
	run: SquareTerminal,
	sessions: MessagesSquare,
	approval: ShieldCheck,
	notify: BellRing,
	desk: NotebookPen,
	routine: CalendarClock,
	tool: Wrench,
};

const FILTERS = ["all", "changes", "reads", "approvals"] as const;
type Filter = (typeof FILTERS)[number];

const SHOWS: Record<Filter, (entry: BotActivity) => boolean> = {
	all: () => true,
	changes: entry => entry.kind === "change" || entry.kind === "desk" || entry.kind === "run",
	reads: entry => entry.kind === "read",
	approvals: entry => entry.kind === "approval",
};

/** Rows the section lists before folding the rest. */
const CAP = 6;

function ActivityRow({
	entry,
	channels,
	device,
}: {
	entry: BotActivity;
	channels: readonly BotChannel[];
	device?: string;
}) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const [pending, setPending] = useState(false);
	const what = entry.action === "tool" ? entry.text : `${t(`botActivity.action.${entry.action}`)}: ${entry.text}`;
	const topic = entry.channel ? channels.find(channel => channel.id === entry.channel)?.title : undefined;
	const meta = [
		formatClock(entry.at),
		entry.by === "owner" ? t("botActivity.byOwner") : null,
		topic ? t("botActivity.inChannel", { topic }) : null,
	]
		.filter(Boolean)
		.join(" · ");
	const action = entry.undone ? (
		<Badge variant="muted">{t("botActivity.undone")}</Badge>
	) : entry.undo ? (
		<Button
			aria-label={t("botActivity.undoLabel", { text: what })}
			data-bot-activity-undo={entry.id}
			disabled={pending}
			icon={<Undo2 />}
			onClick={async () => {
				setPending(true);
				await edit({ op: "undo", activity: entry.id }, device);
				setPending(false);
			}}
			size="sm"
			variant="ghost"
		>
			{t("botActivity.undo")}
		</Button>
	) : undefined;
	return (
		<BoardRow
			{...(action ? { action } : {})}
			data={{ "data-bot-activity": entry.id, "data-bot-activity-kind": entry.kind }}
			label={what}
			lead={<KindMark icon={KIND_ICON[entry.kind]} tone={entry.kind === "approval" ? "warning" : "muted"} />}
			meta={meta}
			title={[what, entry.target?.value, entry.detail].filter(Boolean).join("\n")}
		/>
	);
}

export function BotActivityRows({ channels, device }: { channels: readonly BotChannel[]; device?: string }) {
	const t = useT();
	const { page, loadError } = useBotActivity(device, true);
	const [filter, setFilter] = useState<Filter>("all");
	const shown = (page?.entries ?? []).filter(SHOWS[filter]).toReversed();
	return (
		<>
			<li className="omp-work-board-item py-1">
				<Select
					aria-label={t("botActivity.filter.label")}
					controlSize="sm"
					data-bot-activity-filter={filter}
					onChange={event => {
						const next = FILTERS.find(value => value === event.target.value);
						if (next) setFilter(next);
					}}
					options={FILTERS.map(value => ({ value, label: t(`botActivity.filter.${value}`) }))}
					value={filter}
				/>
			</li>
			{loadError && !page ? (
				<li>
					<InlineNotice detail={loadError} title={t("botActivity.loadFailed")} tone="danger" />
				</li>
			) : !page ? (
				<li>
					<SkeletonRows label={t("botHome.loading")} widths={[70, 50, 60]} />
				</li>
			) : shown.length === 0 ? (
				<li className="omp-work-board-item py-1 text-sc-sm text-(--sc-text-muted)">{t("botActivity.none")}</li>
			) : (
				<CappedRows cap={CAP} items={shown}>
					{entry => <ActivityRow channels={channels} device={device} entry={entry} key={entry.id} />}
				</CappedRows>
			)}
		</>
	);
}
