import { Bot, GitBranch, SquareTerminal } from "lucide-react";
import { useRef } from "react";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { useOverlayPresence } from "../../../hooks/use-overlay-presence";
import { ATTENTION_LABEL_KEY } from "../../../lib/attention";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { revealSidebarSubagents } from "../../../stores/sidebar-subagents";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
import { Badge, Button, StatusDot, Tooltip } from "../../common";

/** Subagent statuses that are doing work; `idle`/`parked` agents wait for a follow-up. */
const WORKING_STATUSES: Record<string, true> = { started: true, running: true, pending: true };
const WAITING_STATUSES: Record<string, true> = { idle: true, parked: true };

const SEGMENT_ICON = "text-(--sc-text-muted)";

/**
 * One row above the composer collecting the session's work that outlives a
 * turn: subagents still working or waiting, the sessions its agent opened (with
 * how many wait on the person, in the title bar's word) and background shells.
 * The session's own question is its prompt card's to say, not this row's. While
 * a turn runs the work card shows the same lanes and the sessions its agent
 * waits on, so the row hides itself until the turn ends.
 */
export function WorkspaceIsland() {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const workingNow = useSubagentsStore(state => {
		let count = 0;
		for (const agent of state.subagents.values()) if (WORKING_STATUSES[agent.status]) count++;
		return count;
	});
	const waitingNow = useSubagentsStore(state => {
		let count = 0;
		for (const agent of state.subagents.values()) if (WAITING_STATUSES[agent.status]) count++;
		return count;
	});
	const openJobs = useUiStore(state => state.openJobs);
	const shellsNow = useBackgroundJobs().length;
	const opened = useOpenedChildren(tabId);
	// Only sessions at work or waiting: a finished one folds away like a finished subagent.
	const now = {
		working: workingNow,
		waiting: waitingNow,
		shells: shellsNow,
		running: opened.counts.running,
		needYou: opened.counts.waiting,
	};
	// While a turn runs the live work card says all of it (its lanes, the sessions its agent waits on): no second row.
	const turnRuns = useSessionStore(state => state.isStreaming);
	const shown = !turnRuns && workingNow + waitingNow + shellsNow + now.running + now.needYou > 0;
	const { mounted, closing } = useOverlayPresence(shown, "fast");
	// The row fades out with the counts it last showed: its sources are already empty by then.
	const remembered = useRef(now);
	if (shown) remembered.current = now;
	if (!mounted) return null;
	const { working, waiting, shells, running, needYou } = remembered.current;
	const agents = working + waiting;
	const sessions = running + needYou;

	return (
		<section
			aria-hidden={closing || undefined}
			aria-label={t("dock.island.label")}
			className={cx(
				"flex min-w-0 flex-wrap items-center gap-1 rounded-(--sc-radius-full) border border-(--sc-border-subtle) bg-(--sc-elevated) p-0.5",
				closing ? "omp-fade-out" : "omp-fade-in",
			)}
			data-workspace-island
			inert={closing}
		>
			{agents > 0 && (
				<Tooltip content={t("dock.island.agentsOpen")}>
					<Button
						className="min-w-0"
						data-island-segment="agents"
						icon={<Bot aria-hidden className={SEGMENT_ICON} />}
						onClick={() => tabId && revealSidebarSubagents(tabId)}
						size="sm"
						variant="ghost"
					>
						<span className="shrink-0 text-(--sc-text)">{t("dock.island.agents")}</span>
						{working > 0 && (
							<StatusDot
								className="shrink-0 tabular-nums"
								label={t("dock.island.working", { count: working })}
								pulse
								tone="info"
							/>
						)}
						{waiting > 0 && (
							<span className="shrink-0 font-normal tabular-nums text-(--sc-text-muted)">
								{t("dock.island.waiting", { count: waiting })}
							</span>
						)}
					</Button>
				</Tooltip>
			)}
			{sessions > 0 && (
				<Tooltip content={t("dock.island.sessionsOpen")}>
					<Button
						className="min-w-0"
						data-island-segment="sessions"
						icon={<GitBranch aria-hidden className={SEGMENT_ICON} />}
						onClick={() => tabId && revealSidebarSubagents(tabId)}
						size="sm"
						variant="ghost"
					>
						<span className="shrink-0 text-(--sc-text)">{t("dock.island.sessions")}</span>
						{running > 0 && (
							<StatusDot
								className="shrink-0 tabular-nums"
								label={t("dock.island.working", { count: running })}
								pulse
								tone="info"
							/>
						)}
						{needYou > 0 && (
							<Badge className="tabular-nums" data-island-sessions-need-you size="xs" variant="warning">
								{t(ATTENTION_LABEL_KEY.childWaiting)} {needYou}
							</Badge>
						)}
					</Button>
				</Tooltip>
			)}
			{shells > 0 && (
				<Tooltip content={t("dock.island.shellsOpen")}>
					<Button
						className="min-w-0"
						data-island-segment="shells"
						icon={<SquareTerminal aria-hidden className={SEGMENT_ICON} />}
						onClick={openJobs}
						size="sm"
						variant="ghost"
					>
						<span className="shrink-0 font-normal tabular-nums">
							{t("dock.island.shells", { count: shells })}
						</span>
					</Button>
				</Tooltip>
			)}
		</section>
	);
}
