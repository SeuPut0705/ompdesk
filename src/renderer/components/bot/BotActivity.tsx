/**
 * The bot's activity log (Muse's Activity log, Grok's audit log) as a section of its work board: what the bot and the
 * owner did, newest first, one chronological list. Nothing here takes a change back: the owner tells the bot, which
 * reverses its own desk changes with `ompdesk_bot` (dots and Grok Bot document no undo; Muse undoes by chat). Read on
 * demand while the board shows it (`stores/bot-activity.ts`).
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
	Wrench,
} from "lucide-react";
import type { BotActivity, BotActivityKind } from "../../../shared/bot-activity";
import type { BotChannel } from "../../../shared/bot-desk";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useBotActivity } from "../../stores/bot-activity";
import { InlineNotice, SkeletonRows } from "../common";
import { BoardRow, BoardSection, CappedRows, KindMark } from "../layout/work-board/board-parts";

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

/** Rows the section lists before folding the rest. */
const CAP = 6;

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** One entry in words: a tool call as the call in short, anything else as its action and subject. */
function activityLine(entry: BotActivity, t: Translate): string {
	return entry.action === "tool" ? entry.text : `${t(`botActivity.action.${entry.action}`)}: ${entry.text}`;
}

function ActivityRow({ entry, channels }: { entry: BotActivity; channels: readonly BotChannel[] }) {
	const t = useT();
	const what = activityLine(entry, t);
	const topic = entry.channel ? channels.find(channel => channel.id === entry.channel)?.title : undefined;
	const meta = [
		formatClock(entry.at),
		entry.by === "owner" ? t("botActivity.byOwner") : null,
		topic ? t("botActivity.inChannel", { topic }) : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<BoardRow
			data={{ "data-bot-activity": entry.id, "data-bot-activity-kind": entry.kind }}
			label={what}
			lead={<KindMark icon={KIND_ICON[entry.kind]} tone={entry.kind === "approval" ? "warning" : "muted"} />}
			meta={meta}
			title={[what, entry.target?.value, entry.detail].filter(Boolean).join("\n")}
		/>
	);
}

/**
 * The Activity section. Folded in the strip's panel, its one line is the newest entry this window already read (no
 * read starts for it); the rows read the log while shown.
 */
export function BotActivitySection({ channels, device }: { channels: readonly BotChannel[]; device?: string }) {
	const t = useT();
	const newest = useBotActivity(device, false).page?.entries.findLast(entry => entry.kind !== "read");
	return (
		<BoardSection
			id="activity"
			summary={{ lead: newest ? activityLine(newest, t) : "" }}
			title={t("botActivity.title")}
		>
			<BotActivityRows channels={channels} device={device} />
		</BoardSection>
	);
}

function BotActivityRows({ channels, device }: { channels: readonly BotChannel[]; device?: string }) {
	const t = useT();
	const { page, loadError } = useBotActivity(device, true);
	// Reads and visits are left out: a reply's Sources chips show them, and the bot lists them when asked (`visited`).
	const shown = (page?.entries ?? []).filter(entry => entry.kind !== "read").toReversed();
	return (
		<>
			{loadError && !page ? (
				<li>
					<InlineNotice detail={loadError} title={t("botActivity.loadFailed")} tone="danger" />
				</li>
			) : !page ? (
				<li>
					<SkeletonRows label={t("botHome.loading")} widths={[70, 50, 60]} />
				</li>
			) : shown.length === 0 ? (
				<li className="omp-work-board-more">{t("botActivity.none")}</li>
			) : (
				<CappedRows cap={CAP} items={shown}>
					{entry => <ActivityRow channels={channels} entry={entry} key={entry.id} />}
				</CappedRows>
			)}
		</>
	);
}
