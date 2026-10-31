/**
 * The bot's Tasks section on its work board (`bot-tasks.ts` builds the lists): In progress, Scheduled, Completed, one
 * line per item. A task row opens its session, where its progress, files, results and open requests are (take over:
 * it is a session tab like any other); a running one can be watched beside the bot (a split pane, live) and stopped
 * on its own, apart from the bot's own turn; a finished one waits for the owner's "Mark done" (only the owner completes
 * a task). A task that waits on an answer is tinted, one finished since the owner last looked carries a dot.
 */
import {
	AlarmClock,
	Check,
	CheckCheck,
	Clock,
	Columns2,
	GitBranch,
	MessageSquare,
	RotateCcw,
	Square,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { BotDeskState } from "../../../shared/bot-desk";
import { useOpenedChildren } from "../../hooks/use-opened-children";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useBotDeskStore, useDecisionClock } from "../../stores/bot-desk";
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
import { botTasks, type TaskItem, type TaskState } from "./bot-tasks";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const CAP = { progress: 6, scheduled: 3, completed: 5 } as const;

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

function TaskRow({ item, now, device }: { item: Extract<TaskItem, { kind: "task" }>; now: number; device?: string }) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const { row, state } = item;
	const title = row.title || t("workBoard.review.untitled");
	const activity = childActivity(row);
	const diff = diffWords(row, t);
	const sub = [activity, diff].filter(Boolean).join(" · ");
	const live = state === "running" || state === "needs";
	const actions: ReactNode[] = [];
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
			action={actions.length > 0 ? <span className="flex shrink-0 items-center">{actions}</span> : undefined}
			data={{
				"data-bot-task": row.sessionPath ?? row.key,
				"data-task-state": state,
				...(item.unread ? { "data-task-unread": "" } : {}),
			}}
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
			tag={{ word: t(`botHome.tasks.state.${state}`), tone: STATE_TAG_TONE[state] }}
			title={[title, row.device ? t("botHome.device", { device: row.device }) : null, row.branch, activity, diff]
				.filter(Boolean)
				.join("\n")}
		/>
	);
}

function OtherRow({ item }: { item: Exclude<TaskItem, { kind: "task" }> }) {
	const t = useT();
	if (item.kind === "wake") {
		const prompt = item.prompt.replace(/\s+/g, " ").trim();
		return (
			<BoardRow
				data={{ "data-bot-wake": item.key.slice("wake:".length) }}
				label={prompt}
				lead={<KindMark icon={AlarmClock} tone={item.next === null ? "muted" : "info"} />}
				meta={item.next === null ? t("botHome.wakes.paused") : formatClock(item.next)}
				tag={{ word: t("botHome.tasks.state.next") }}
				title={item.prompt}
			/>
		);
	}
	const { decision } = item;
	const answer = decision.state === "answered" ? decision.answer : null;
	return (
		<BoardRow
			data={{ [item.outcome === "answered" ? "data-bot-answered" : "data-bot-expired"]: decision.id }}
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

function Group({
	name,
	items,
	cap,
	children,
	extra,
}: {
	name: string;
	items: readonly TaskItem[];
	cap: number;
	children: (item: TaskItem) => ReactNode;
	extra?: ReactNode;
}) {
	// A group with nothing in it says nothing: three "0" headings would be noise.
	if (items.length === 0) return null;
	return (
		<>
			<li className="omp-work-board-group" data-bot-task-group={name}>
				{name}
				<span className="tabular-nums">{items.length}</span>
			</li>
			<CappedRows cap={cap} items={items}>
				{children}
			</CappedRows>
			{extra}
		</>
	);
}

export function BotTasksSection({ tabId, desk, device }: { tabId: string; desk: BotDeskState; device?: string }) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const opened = useOpenedChildren(tabId);
	const unreadIds = useTabsStore(state =>
		state.tabs
			.filter(tab => tab.unreadDone)
			.map(tab => tab.id)
			.join("\n"),
	);
	const running = opened.rows.some(row => row.status === "running");
	const now = useNowTick(running);
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
	const review = lists.progress.flatMap(item =>
		item.kind === "task" && item.state === "review" && item.row.sessionPath ? [item.row.sessionPath] : [],
	);
	const render = (item: TaskItem) =>
		item.kind === "task" ? (
			<TaskRow device={device} item={item} key={item.key} now={now} />
		) : (
			<OtherRow item={item} key={item.key} />
		);
	const lead = lists.progress[0];
	return (
		<BoardSection
			action={opened.rows.length > 0 ? <WorkTreeButton /> : null}
			count={lists.progress.length > 0 ? lists.progress.length : undefined}
			id="tasks"
			summary={{
				lead:
					lead?.kind === "task"
						? lead.row.title || t("workBoard.review.untitled")
						: t("botHome.tasks.noneInProgress"),
				count: lists.progress.length > 0 ? lists.progress.length : undefined,
			}}
			title={t("botHome.tasks.title")}
		>
			<Group
				cap={CAP.progress}
				extra={
					review.length > 1 ? (
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
					) : null
				}
				items={lists.progress}
				name={t("botHome.tasks.group.progress")}
			>
				{render}
			</Group>
			<Group cap={CAP.scheduled} items={lists.scheduled} name={t("botHome.tasks.group.scheduled")}>
				{render}
			</Group>
			<Group cap={CAP.completed} items={lists.completed} name={t("botHome.tasks.group.completed")}>
				{render}
			</Group>
			{lists.progress.length + lists.scheduled.length + lists.completed.length === 0 ? (
				<li className="omp-work-board-more" data-bot-tasks-empty="">
					{t("botHome.tasks.noneInProgress")}
				</li>
			) : null}
		</BoardSection>
	);
}
