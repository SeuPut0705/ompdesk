/**
 * The bot's Library on its work board (`bot-library.ts` collects it): what its work produced, one line each with where
 * it came from. A file opens in the Files viewer (preview), a pull request, issue, release or commit in the browser,
 * a branch or a report in the session that made it. Each item can be pinned to the top (the desk's `libraryPins`, so
 * every window and paired device sees the same pins); a file the bot wrote again after naming it says "Updated HH:MM".
 */
import { FileText, GitBranch, GitCommitHorizontal, GitPullRequest, Pin, PinOff, ScrollText, Tag } from "lucide-react";
import { useMemo } from "react";
import { useOpenedChildren } from "../../hooks/use-opened-children";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { messageText } from "../../lib/messages";
import { openExternal } from "../../lib/open-external";
import { EDIT_TOOLS } from "../../lib/panel-auto-open";
import { useBotDeskStore } from "../../stores/bot-desk";
import { useMessagesStore } from "../../stores/messages";
import { useToolsStore } from "../../stores/tools";
import { IconButton } from "../common";
import { BoardRow, BoardSection, CappedRows, KindMark } from "../layout/work-board/board-parts";
import { openOpenedChild } from "../layout/work-board/open-peer";
import { previewFile } from "../tools/media/file-actions";
import { botLibrary, type LibraryItem } from "./bot-library";

const CAP = 6;

const LINK_ICON = { pull: GitPullRequest, issue: ScrollText, release: Tag, commit: GitCommitHorizontal } as const;

function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function clock(at: number): string {
	return formatClock(new Date(at).toISOString());
}

function LibraryRow({ item, device }: { item: LibraryItem; device?: string }) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const pin = (
		<IconButton
			data-bot-library-pin={item.pinned ? "pinned" : "unpinned"}
			icon={item.pinned ? <PinOff /> : <Pin />}
			label={t(item.pinned ? "botHome.library.unpin" : "botHome.library.pin")}
			onClick={() => void edit({ op: "library_pin", key: item.key, pinned: !item.pinned }, device)}
			size="sm"
		/>
	);
	const source =
		item.kind === "link" || item.kind === "file"
			? item.source.kind === "reply"
				? t("botHome.library.fromReply", { time: clock(item.source.at) })
				: t("botHome.library.fromSession", { title: item.source.title || t("workBoard.review.untitled") })
			: null;
	const data = { "data-bot-library": item.key, ...(item.pinned ? { "data-pinned": "" } : {}) };
	if (item.kind === "branch") {
		const { row } = item;
		const diff = row.diff
			? `${t("botHome.tasks.commits", { count: row.diff.commits })} · ${t("botHome.tasks.files", { count: row.diff.files })} +${row.diff.added} −${row.diff.removed}`
			: t(row.merge === "merged" ? "workBoard.opened.merge.merged" : "workBoard.opened.merge.unmerged");
		return (
			<BoardRow
				action={pin}
				data={data}
				label={row.branch}
				lead={<KindMark icon={GitBranch} tone={row.merge === "unmerged" ? "warning" : "success"} />}
				meta={item.at ? clock(item.at) : undefined}
				onClick={() => openOpenedChild(row)}
				sub={<span className="truncate">{[row.title, diff].filter(Boolean).join(" · ")}</span>}
				title={[row.branch, row.title, diff].join("\n")}
			/>
		);
	}
	if (item.kind === "report")
		return (
			<BoardRow
				action={pin}
				data={data}
				label={item.row.title || t("workBoard.review.untitled")}
				lead={<KindMark icon={ScrollText} tone="muted" />}
				meta={item.at ? clock(item.at) : undefined}
				onClick={() => openOpenedChild(item.row)}
				sub={<span className="truncate">{item.text.replace(/\s+/g, " ")}</span>}
				tag={{ word: t("botHome.library.report") }}
				title={item.text}
			/>
		);
	if (item.kind === "link") {
		const { link } = item;
		const label =
			link.type === "pull"
				? t("botHome.library.pull", { ref: link.ref })
				: link.type === "issue"
					? t("botHome.library.issue", { ref: link.ref })
					: link.type === "release"
						? t("botHome.library.release", { ref: link.ref })
						: t("botHome.library.commit", { ref: link.ref });
		return (
			<BoardRow
				action={pin}
				data={data}
				label={`${label} · ${link.repo}`}
				lead={<KindMark icon={LINK_ICON[link.type]} tone="info" />}
				meta={clock(item.at)}
				onClick={() => openExternal(item.url)}
				sub={source ? <span className="truncate">{source}</span> : undefined}
				title={[item.url, source].filter(Boolean).join("\n")}
			/>
		);
	}
	return (
		<BoardRow
			action={pin}
			data={data}
			label={fileName(item.path)}
			lead={<KindMark icon={FileText} tone="muted" />}
			meta={item.updated ? t("botHome.library.updated", { time: clock(item.updated) }) : clock(item.at)}
			onClick={() => previewFile(item.path, false)}
			sub={source ? <span className="truncate">{source}</span> : undefined}
			title={[item.path, source].filter(Boolean).join("\n")}
		/>
	);
}

export function BotLibrarySection({
	tabId,
	pins,
	device,
}: {
	tabId: string;
	pins: readonly string[];
	device?: string;
}) {
	const t = useT();
	const opened = useOpenedChildren(tabId);
	const messages = useMessagesStore(state => state.messages);
	const finished = useToolsStore(state => state.finishedTools);
	const finishedVersion = useToolsStore(state => state.finishedVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishedVersion marks the finished map changing in place.
	const items = useMemo(() => {
		const replies = messages.flatMap(message =>
			message.role === "assistant"
				? [
						{
							text: messageText(message),
							at:
								typeof message.timestamp === "number"
									? message.timestamp
									: Date.parse(String(message.timestamp ?? "")) || 0,
						},
					]
				: [],
		);
		const writes = [...finished.values()].flatMap(entry =>
			EDIT_TOOLS[entry.toolName] && entry.status === "done" && typeof entry.args.path === "string"
				? [{ path: entry.args.path, at: entry.endTime ?? entry.startTime }]
				: [],
		);
		return botLibrary({ rows: opened.rows, replies, writes, pins });
	}, [messages, finished, finishedVersion, opened.rows, pins]);
	if (items.length === 0) return null;
	const lead = items[0];
	return (
		<BoardSection
			count={items.length}
			id="library"
			summary={{
				lead:
					lead?.kind === "file"
						? fileName(lead.path)
						: lead?.kind === "link"
							? lead.url
							: lead?.kind === "branch"
								? (lead.row.branch ?? "")
								: (lead?.row.title ?? ""),
				count: items.length,
			}}
			title={t("botHome.library.title")}
		>
			<CappedRows cap={CAP} items={items}>
				{item => <LibraryRow device={device} item={item} key={item.key} />}
			</CappedRows>
		</BoardSection>
	);
}
