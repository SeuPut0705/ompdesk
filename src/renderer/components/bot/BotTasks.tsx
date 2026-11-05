/**
 * The bot's Tasks and Completed sections on its work board (`bot-tasks.ts` builds the lists), one line per item. A
 * task row opens its session, where its progress, files, results and open requests are (take over: it is a session
 * tab like any other); a running one can be watched beside the bot (a split pane, live) and stopped on its own, apart
 * from the bot's own turn; a finished one waits for the owner's "Mark done" (only the owner completes a task). A task
 * that waits on an answer is tinted, one finished since the owner last looked carries a dot. Completed holds the tasks
 * the owner marked done and the decisions answered or lapsed, newest first.
 */
import {
	Check,
	CheckCheck,
	Clock,
	Columns2,
	GitBranch,
	MessageSquare,
	RotateCcw,
	Square,
	SquareTerminal,
	Undo2,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { BotDeskState } from "../../../shared/bot-desk";
import { useOpenedChildren } from "../../hooks/use-opened-children";
import { usePresence } from "../../hooks/use-presence";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useBotDesk, useBotDeskStore, useDecisionClock } from "../../stores/bot-desk";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { IconButton } from "../common";
import {
	BoardRow,
	BoardSection,
	CappedRows,
	Dot,
	elapsedLabel,
	KindMark,
	type RowTag,
	WorkTreeButton,
} from "../layout/work-board/board-parts";
import { openOpenedChild } from "../layout/work-board/open-peer";
import { childActivity, type OpenedChildRow } from "../layout/work-board/opened-children";
import { handBackTask, takeOverTask } from "./BotTakeover";
import { botTasks, type TaskItem, type TaskState } from "./bot-tasks";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const CAP = { progress: 6, completed: 5 } as const;

const STATE_TONE: Record<TaskState, "info" | "success" | "warning" | "danger" | "muted"> = {
	needs: "warning",
	running: "info",
	failed: "danger",
	review: "success",
	done: "muted",
};

const STATE_TAG_TONE: Partial<Record<TaskState, RowTag["tone"]>> = { needs: "warning", failed: "danger" };

/** "3 commits · 5 files +40 −2", what a task's branch holds; null without a branch that holds anything. */
function diffWords(row: OpenedChildRow, t: Translate): string | null {
	if (!row.diff) return null;
	const parts = [
		row.diff.commits > 0 ? t("botHome.tasks.commits", { count: row.diff.commits }) : null,
		row.diff.files > 0
			? `${t("botHome.tasks.files", { count: row.diff.files })} +${row.diff.added} −${row.diff.removed}`
			: null,
		row.diff.uncommitted > 0 ? t("botHome.tasks.uncommitted", { count: row.diff.uncommitted }) : null,
	];
	return parts.filter(Boolean).join(" · ") || null;
}

function stopChild(tabId: string, t: Translate): void {
	window.omp.rpc.commandForTab(tabId, { type: "abort", origin: { surface: "bot-activity" } }).then(
		response => {
			if (!response.success) toastError({ title: t("botHome.stopFailed"), error: response });
		},
		(error: unknown) => toastError({ title: t("botHome.stopFailed"), error }),
	);
}

function TaskRow({
	item,
	now,
	device,
	exiting = false,
}: {
	item: Extract<TaskItem, { kind: "task" }>;
	now: number;
	device?: string;
	/** Left the list: kept for its exit, out of the tab order and the screen reader (`BoardRow`). */
	exiting?: boolean;
}) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const { row, state } = item;
	const title = row.title || t("workBoard.review.untitled");
	const activity = childActivity(row);
	const diff = diffWords(row, t);
	const sub = [activity, diff].filter(Boolean).join(" · ");
	const live = state === "running" || state === "needs";
	const actions: ReactNode[] = [];
	const sessionPath = row.sessionPath;
	const taken =
		useBotDesk(device).desk.takeovers?.some(
			entry => sessionPath !== undefined && entry.sessionPath === sessionPath,
		) ?? false;
	if (live && row.tabId) {
		const tabId = row.tabId;
		actions.push(
			<IconButton
				data-bot-task-watch=""
				icon={<Columns2 />}
				key="watch"
				label={t("botHome.tasks.watch", { title })}
				onClick={() =>
					void useTabsStore
						.getState()
						.applyAgentView({ tabId, how: "split-right" })
						.catch((error: unknown) => toastError({ title: t("botHome.tasks.openFailed"), error }))
				}
				size="sm"
			/>,
		);
		if (state === "running")
			actions.push(
				<IconButton
					data-bot-task-stop=""
					icon={<Square />}
					key="stop"
					label={t("botHome.tasks.stop", { title })}
					onClick={() => stopChild(tabId, t)}
					size="sm"
				/>,
			);
	}
	// Take over: its turn stops and its terminal opens in its folder; Hand back tells it what the owner ran there.
	if (sessionPath && (taken || state !== "done"))
		actions.push(
			<IconButton
				data-bot-task-takeover={taken ? "hand-back" : "take"}
				icon={taken ? <Undo2 /> : <SquareTerminal />}
				key="takeover"
				label={t(taken ? "botTakeover.handBackTask" : "botTakeover.takeTask", { title })}
				onClick={() => void (taken ? handBackTask(sessionPath, device) : takeOverTask(row, device))}
				size="sm"
			/>,
		);
	if ((state === "review" || state === "done") && row.sessionPath) {
		const sessions = [row.sessionPath];
		const done = state === "review";
		actions.push(
			<IconButton
				data-bot-task-mark={done ? "done" : "reopen"}
				icon={done ? <Check /> : <RotateCcw />}
				key="mark"
				label={t(done ? "botHome.tasks.markDone" : "botHome.tasks.reopen", { title })}
				onClick={() => void edit({ op: "tasks_done", sessions, done }, device)}
				size="sm"
			/>,
		);
	}
	const meta =
		state === "running" && row.since !== undefined
			? elapsedLabel(Math.max(0, now - row.since))
			: item.at !== undefined
				? formatClock(new Date(item.at).toISOString())
				: undefined;
	return (
		<BoardRow
			flipKey={item.key}
			action={actions.length > 0 ? <span className="flex shrink-0 items-center">{actions}</span> : undefined}
			data={{
				"data-bot-task": row.sessionPath ?? row.key,
				"data-task-state": state,
				...(item.unread ? { "data-task-unread": "" } : {}),
			}}
			exiting={exiting}
			label={title}
			lead={
				item.unread ? (
					<Dot tone="info" />
				) : (
					<KindMark icon={row.branch ? GitBranch : MessageSquare} tone={STATE_TONE[state]} />
				)
			}
			meta={meta}
			onClick={() => openOpenedChild(row)}
			sub={sub ? <span className="truncate">{sub}</span> : undefined}
			tag={
				taken
					? { word: t("botTakeover.tag"), tone: "warning" }
					: { word: t(`botHome.tasks.state.${state}`), tone: STATE_TAG_TONE[state] }
			}
			title={[title, row.device ? t("botHome.device", { device: row.device }) : null, row.branch, activity, diff]
				.filter(Boolean)
				.join("\n")}
		/>
	);
}

function DecisionRow({ item }: { item: Extract<TaskItem, { kind: "decision" }> }) {
	const t = useT();
	const { decision } = item;
	const answer = decision.state === "answered" ? decision.answer : null;
	return (
		<BoardRow
			flipKey={item.key}
			data={{
				[item.outcome === "answered" ? "data-bot-answered" : "data-bot-expired"]: decision.id,
			}}
			label={decision.question}
			lead={
				item.outcome === "answered" ? (
					<Check aria-hidden className="size-3 text-(--sc-success)" />
				) : (
					<Clock aria-hidden className="size-3 text-(--sc-text-subtle)" />
				)
			}
			meta={formatClock(new Date(item.at).toISOString())}
			sub={answer ? <span className="truncate">{t("botHome.answered", { answer })}</span> : undefined}
			tag={{ word: t(item.outcome === "answered" ? "botHome.tasks.state.decided" : "botHome.expired") }}
			title={[
				decision.question,
				decision.operation,
				answer ? t("botHome.answered", { answer }) : t("botHome.expired"),
			]
				.filter(Boolean)
				.join("\n")}
		/>
	);
}

/** The two lists, from the sessions the bot opened, the desk and the unread marks of their tabs. */
function useBotTaskLists(tabId: string, desk: BotDeskState) {
	const opened = useOpenedChildren(tabId);
	const unreadIds = useTabsStore(state =>
		state.tabs
			.filter(tab => tab.unreadDone)
			.map(tab => tab.id)
			.join("\n"),
	);
	// Completed takes a decision the moment its deadline passes, with nothing else changing.
	const clock = useDecisionClock(desk);
	const lists = useMemo(() => {
		const unread = new Set(unreadIds.split("\n"));
		return botTasks({
			rows: opened.rows,
			desk,
			unread: row => row.tabId !== null && unread.has(row.tabId),
			now: clock,
		});
	}, [opened.rows, desk, unreadIds, clock]);
	return { lists, opened: opened.rows };
}

/**
 * In progress: what the bot's sessions do now, the ones that need an answer first. A task the owner marks done leaves
 * this list by fading out (`usePresence`, the board's own exit for a row) while the rows below it glide up (the
 * section's `useListMotion`, rows keyed by `flipKey`); it arrives in Completed as a new row there.
 */
export function BotTasksSection({ tabId, desk, device }: { tabId: string; desk: BotDeskState; device?: string }) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const { lists, opened } = useBotTaskLists(tabId, desk);
	const now = useNowTick(opened.some(row => row.status === "running"));
	const shown = usePresence(lists.progress, item => item.key);
	const review = lists.progress.flatMap(item =>
		item.kind === "task" && item.state === "review" && item.row.sessionPath ? [item.row.sessionPath] : [],
	);
	const lead = lists.progress[0];
	const count = lists.progress.length > 0 ? lists.progress.length : undefined;
	return (
		<BoardSection
			action={opened.length > 0 ? <WorkTreeButton /> : null}
			count={count}
			empty={shown.length === 0 ? t("botHome.tasks.noneInProgress") : undefined}
			id="tasks"
			summary={{
				lead:
					lead?.kind === "task"
						? lead.row.title || t("workBoard.review.untitled")
						: t("botHome.tasks.noneInProgress"),
				count,
			}}
			title={t("botHome.tasks.title")}
		>
			<CappedRows cap={CAP.progress} items={shown}>
				{({ item, exiting }) =>
					item.kind === "task" ? (
						<TaskRow device={device} exiting={exiting} item={item} key={item.key} now={now} />
					) : null
				}
			</CappedRows>
			{review.length > 1 ? (
				<li className="omp-work-board-item">
					{/* controls-ok: the omp-work-board-more class draws the whole row */}
					<button
						className="omp-work-board-more"
						data-bot-task-mark-all=""
						onClick={() => void edit({ op: "tasks_done", sessions: review, done: true }, device)}
						type="button"
					>
						<CheckCheck aria-hidden className="me-1.5 size-3.5" />
						{t("botHome.tasks.markAllDone", { count: review.length })}
					</button>
				</li>
			) : null}
		</BoardSection>
	);
}

/** Completed: the tasks the owner marked done and the decisions answered or lapsed; absent while there are none. */
export function BotCompletedSection({ tabId, desk, device }: { tabId: string; desk: BotDeskState; device?: string }) {
	const t = useT();
	const { lists } = useBotTaskLists(tabId, desk);
	if (lists.completed.length === 0) return null;
	const lead = lists.completed[0];
	return (
		<BoardSection
			count={lists.completed.length}
			id="completed"
			summary={{
				lead:
					lead?.kind === "task"
						? lead.row.title || t("workBoard.review.untitled")
						: (lead?.decision.question ?? ""),
				count: lists.completed.length,
			}}
			title={t("botHome.tasks.group.completed")}
		>
			<CappedRows cap={CAP.completed} items={lists.completed}>
				{item =>
					item.kind === "task" ? (
						<TaskRow device={device} item={item} key={item.key} now={0} />
					) : (
						<DecisionRow item={item} key={item.key} />
					)
				}
			</CappedRows>
		</BoardSection>
	);
}
