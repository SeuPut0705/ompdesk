import { Check, Circle, CircleDot } from "lucide-react";
import { useMemo } from "react";
import type { AutopilotChildLive } from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import { cx, formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../../stores/tools";
import { todoBoard } from "../../layout/work-board/work-board";
import { AreaIcon } from "./AreaIcon";
import { AUTOPILOT_STEPS, type AutopilotStep, autopilotProgress } from "./autopilot-view";

/** A call within this of the cycle's start belongs to it (the two clocks come from different events). */
const CLOCK_SLACK_MS = 500;
const TODO_ROWS = 4;

/** The cycle's tool calls, live and finished, oldest first. */
export function useCycleCalls(since: number | undefined): ToolEntry[] {
	const live = useToolsStore(s => s.liveTools);
	const finishedVersion = useToolsStore(s => s.finishedVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishedVersion marks the finished map changing in place.
	return useMemo(() => {
		if (since === undefined) return [];
		const finished = useToolsStore.getState().finishedTools;
		return [...finished.values(), ...live.values()]
			.filter(entry => entry.startTime >= since - CLOCK_SLACK_MS && entry.status !== "aborted")
			.sort((a, b) => a.startTime - b.startTime);
	}, [since, live, finishedVersion]);
}

/** One line for a call: the bash command, the path, or the tool's own intent. */
function callLabel(entry: ToolEntry): string {
	const { args } = entry;
	const text = [args.command, args.path, args.file_path, args.pattern, args.op].find(
		value => typeof value === "string",
	);
	return `${entry.toolName}${typeof text === "string" && text ? `  ${text.replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
}

function ChildRow({ child }: { child: AutopilotChildLive }) {
	const t = useT();
	const tab = useTabsStore(s => s.tabs.find(candidate => candidate.id === child.tabId));
	const label = tab?.title ?? child.branch ?? child.area ?? child.tabId;
	const open = tab ? () => void useTabsStore.getState().switchTab(child.tabId) : undefined;
	const body = (
		<>
			<span
				aria-hidden
				className={cx(
					"size-1.5 shrink-0 rounded-full",
					child.status === "running" && "omp-pulse-dot bg-(--sc-info)",
					child.status === "done" && "bg-(--sc-success)",
					child.status === "failed" && "bg-(--sc-danger)",
					child.status === "closed" && "bg-(--sc-text-subtle)",
				)}
			/>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<span className="shrink-0 text-(--sc-text-muted)">{t(`autopilot.child.${child.status}`)}</span>
		</>
	);
	return (
		<li className="min-w-0" data-autopilot-child={child.tabId}>
			{open ? (
				<button
					className="flex w-full min-w-0 items-center gap-2 rounded-(--sc-radius-sm) px-1 py-0.5 text-left hover:bg-(--sc-surface-2)"
					onClick={open}
					type="button"
				>
					{body}
				</button>
			) : (
				<div className="flex min-w-0 items-center gap-2 px-1 py-0.5">{body}</div>
			)}
		</li>
	);
}

/** What the agent is doing right now: the step, the running call, its todo list and the child sessions of the cycle. */
export function AutopilotNow() {
	const t = useT();
	const now = useAutopilotStore(s => s.status.now);
	const state = useAutopilotStore(s => s.status.state);
	const children = useAutopilotStore(s => s.status.children);
	const calls = useCycleCalls(now?.startedAt);
	const phases = useTodoStore(s => s.phases);
	const board = useMemo(() => todoBoard(phases), [phases]);
	const running = useToolsStore(s => [...s.liveTools.values()].at(-1));
	const clock = useNowTick(running !== undefined);
	const { current, done } = useMemo(() => autopilotProgress(calls), [calls]);
	const between = !now;
	return (
		<section className="flex flex-col gap-2 border-t border-(--sc-divider) px-3 py-3" data-autopilot-now>
			<h3 className="flex items-center gap-2 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
				{t("autopilot.now")}
				{now && (
					<span className="flex min-w-0 items-center gap-1 text-sc-xs font-normal tracking-normal normal-case">
						{now.area && <AreaIcon area={now.area} />}
						<span className="truncate">
							{t("autopilot.cycleN", { n: now.n })}
							{now.area ? ` · ${t(`autopilot.area.${now.area}`)}` : ""}
						</span>
					</span>
				)}
			</h3>
			{between ? (
				<p className="text-sc-sm text-(--sc-text-muted)" data-autopilot-between>
					{state === "paused" || state === "ended" || state === "waiting_quota"
						? t(`autopilot.state.${state}`)
						: t("autopilot.between")}
				</p>
			) : (
				<>
					{now.title && (
						<p className="truncate text-sc-sm" data-autopilot-pick title={now.title}>
							{now.title}
						</p>
					)}
					<ol className="flex flex-wrap gap-x-3 gap-y-1 text-sc-sm" data-autopilot-steps>
						{AUTOPILOT_STEPS.map((step: AutopilotStep) => (
							<li
								className={cx(
									"flex items-center gap-1",
									current === step ? "font-medium text-(--sc-text)" : "text-(--sc-text-muted)",
								)}
								data-step={step}
								data-state={done.includes(step) ? "done" : current === step ? "current" : "todo"}
								key={step}
							>
								{done.includes(step) ? (
									<Check aria-hidden className="size-3 text-(--sc-success)" />
								) : current === step ? (
									<CircleDot aria-hidden className="size-3 text-(--sc-accent)" />
								) : (
									<Circle aria-hidden className="size-3" />
								)}
								{t(`autopilot.step.${step}`)}
							</li>
						))}
					</ol>
					{running && (
						<p
							className="flex min-w-0 items-baseline gap-2 font-mono text-sc-xs text-(--sc-text-secondary)"
							data-autopilot-call
						>
							<span className="min-w-0 flex-1 truncate">{callLabel(running)}</span>
							<span className="shrink-0 tabular-nums text-(--sc-text-muted)">
								{formatElapsed(Math.max(0, clock - running.startTime))}
							</span>
						</p>
					)}
					{board && (
						<ul className="flex flex-col gap-0.5 text-sc-xs" data-autopilot-todo>
							{board.rows.slice(0, TODO_ROWS).map(row => (
								<li className="flex min-w-0 items-center gap-1.5" key={row.content}>
									{row.status === "completed" ? (
										<Check aria-hidden className="size-3 shrink-0 text-(--sc-success)" />
									) : (
										<Circle aria-hidden className="size-3 shrink-0 text-(--sc-text-subtle)" />
									)}
									<span className={cx("truncate", row.status === "completed" && "text-(--sc-text-muted)")}>
										{row.content}
									</span>
								</li>
							))}
						</ul>
					)}
				</>
			)}
			{children && children.length > 0 && (
				<div className="flex flex-col gap-1">
					<span className="text-sc-xs text-(--sc-text-muted)">
						{t("autopilot.children", { count: children.length })}
					</span>
					<ul className="flex flex-col text-sc-xs">
						{children.map(child => (
							<ChildRow child={child} key={child.tabId} />
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
