import { Bot, GitBranch, SquareTerminal } from "lucide-react";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { useT } from "../../../lib/i18n";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { revealSidebarSubagents } from "../../../stores/sidebar-subagents";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";

/** Subagent statuses that are doing work; `idle`/`parked` agents wait for a follow-up. */
const WORKING_STATUSES: Record<string, true> = { started: true, running: true, pending: true };
const WAITING_STATUSES: Record<string, true> = { idle: true, parked: true };

const SEGMENT =
	"flex h-7 min-w-0 items-center gap-1.5 rounded-(--sc-radius-full) px-2.5 text-sc-sm text-(--sc-text-secondary) hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-2 focus-visible:outline-(--sc-accent)";

/**
 * One row above the composer collecting the session's work that outlives a
 * turn: subagents still working or waiting (with how many questions block on
 * the user) and background shells. While a turn runs the work card shows the
 * same lanes and the sessions its agent waits on, so the row hides itself
 * until the turn ends.
 */
export function WorkspaceIsland() {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const working = useSubagentsStore(state => {
		let count = 0;
		for (const agent of state.subagents.values()) if (WORKING_STATUSES[agent.status]) count++;
		return count;
	});
	const waiting = useSubagentsStore(state => {
		let count = 0;
		for (const agent of state.subagents.values()) if (WAITING_STATUSES[agent.status]) count++;
		return count;
	});
	const needsYou = useExtensionUiStore(
		state => state.pendingRequests.filter(request => isUserBlockingRequest(state, request)).length,
	);
	const openJobs = useUiStore(state => state.openJobs);
	const shells = useBackgroundJobs().length;
	const agents = working + waiting;
	const opened = useOpenedChildren(tabId);
	// Only sessions at work or waiting: a finished one folds away like a finished subagent.
	const sessions = opened.counts.running + opened.counts.waiting;
	// While a turn runs the live work card says all of it (its lanes, the sessions its agent waits on): no second row.
	const turnRuns = useSessionStore(state => state.isStreaming);

	if (turnRuns || (agents === 0 && shells === 0 && sessions === 0)) return null;

	return (
		<section
			aria-label={t("dock.island.label")}
			className="flex min-w-0 flex-wrap items-center gap-1 rounded-(--sc-radius-full) border border-(--sc-border-subtle) bg-(--sc-elevated) p-0.5"
			data-workspace-island
		>
			{agents > 0 && (
				<button
					className={SEGMENT}
					data-island-segment="agents"
					onClick={() => tabId && revealSidebarSubagents(tabId)}
					title={t("dock.island.agentsOpen")}
					type="button"
				>
					<Bot aria-hidden className="shrink-0 text-(--sc-text-muted)" size={14} />
					<span className="shrink-0 font-medium text-(--sc-text)">{t("dock.island.agents")}</span>
					{working > 0 && (
						<span className="flex shrink-0 items-center gap-1 tabular-nums">
							<span aria-hidden className="omp-pulse-dot size-1.5 rounded-full bg-(--sc-info)" />
							{t("dock.island.working", { count: working })}
						</span>
					)}
					{waiting > 0 && (
						<span className="shrink-0 tabular-nums text-(--sc-text-muted)">
							{t("dock.island.waiting", { count: waiting })}
						</span>
					)}
					{needsYou > 0 && (
						<span
							className="shrink-0 rounded-(--sc-radius-full) bg-(--sc-warning-soft) px-1.5 tabular-nums text-(--sc-warning-on-soft)"
							data-island-needs-you
						>
							{t("dock.island.needsYou", { count: needsYou })}
						</span>
					)}
				</button>
			)}
			{sessions > 0 && (
				<button
					className={SEGMENT}
					data-island-segment="sessions"
					onClick={() => tabId && revealSidebarSubagents(tabId)}
					title={t("dock.island.sessionsOpen")}
					type="button"
				>
					<GitBranch aria-hidden className="shrink-0 text-(--sc-text-muted)" size={14} />
					<span className="shrink-0 font-medium text-(--sc-text)">{t("dock.island.sessions")}</span>
					{opened.counts.running > 0 && (
						<span className="flex shrink-0 items-center gap-1 tabular-nums">
							<span aria-hidden className="omp-pulse-dot size-1.5 rounded-full bg-(--sc-info)" />
							{t("dock.island.working", { count: opened.counts.running })}
						</span>
					)}
					{opened.counts.waiting > 0 && (
						<span
							className="shrink-0 rounded-(--sc-radius-full) bg-(--sc-warning-soft) px-1.5 tabular-nums text-(--sc-warning-on-soft)"
							data-island-sessions-need-you
						>
							{t("dock.island.needsYou", { count: opened.counts.waiting })}
						</span>
					)}
				</button>
			)}
			{shells > 0 && (
				<button
					className={SEGMENT}
					data-island-segment="shells"
					onClick={openJobs}
					title={t("dock.island.shellsOpen")}
					type="button"
				>
					<SquareTerminal aria-hidden className="shrink-0 text-(--sc-text-muted)" size={14} />
					<span className="shrink-0 tabular-nums">{t("dock.island.shells", { count: shells })}</span>
				</button>
			)}
		</section>
	);
}
