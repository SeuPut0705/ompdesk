import { Bot, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import type { RpcJobsResult } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { revealSidebarSubagents } from "../../../stores/sidebar-subagents";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";

/** Subagent statuses that are doing work; `idle`/`parked` agents wait for a follow-up. */
const WORKING_STATUSES: Record<string, true> = { started: true, running: true, pending: true };
const WAITING_STATUSES: Record<string, true> = { idle: true, parked: true };
/** How often the island re-reads stock's background jobs while the page is visible. */
const JOBS_POLL_MS = 3000;

const SEGMENT =
	"flex h-7 min-w-0 items-center gap-1.5 rounded-(--sc-radius-full) px-2.5 text-sc-sm text-(--sc-text-secondary) hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-2 focus-visible:outline-(--sc-accent)";

/** Running background shells (stock `bash`/`eval` jobs; `task` jobs are the agents segment). */
function useRunningShells(): number {
	const rpc = useTabRpc();
	const [running, setRunning] = useState(0);
	useEffect(() => {
		let cancelled = false;
		let pending = false;
		const refresh = async () => {
			if (pending || document.visibilityState === "hidden") return;
			pending = true;
			try {
				const response = await rpc.getJobs();
				if (cancelled || !response.success) return;
				const { jobs } = response.data as RpcJobsResult;
				setRunning(jobs.filter(job => job.type !== "task" && job.status === "running").length);
			} catch {
				// No count beats a wrong one; the Background tasks view reports the error.
			} finally {
				pending = false;
			}
		};
		void refresh();
		const poll = window.setInterval(() => void refresh(), JOBS_POLL_MS);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			cancelled = true;
			window.clearInterval(poll);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [rpc]);
	return running;
}

/**
 * One row above the composer collecting the session's work that outlives a
 * turn: subagents still working or waiting (with how many questions block on
 * the user) and background shells. While a turn runs, the work card shows the
 * same lanes, so the dock mounts this only between turns.
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
	const shells = useRunningShells();
	const agents = working + waiting;

	if (agents === 0 && shells === 0) return null;

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
							className="shrink-0 rounded-(--sc-radius-full) bg-(--sc-warning-soft) px-1.5 tabular-nums text-(--sc-warning)"
							data-island-needs-you
						>
							{t("dock.island.needsYou", { count: needsYou })}
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
