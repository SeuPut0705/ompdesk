/**
 * Agents dock line: while subagents run, ONE compact row above the composer —
 * status counts and the latest active agent. The roster itself lives in the
 * sidebar, nested under its session; clicking the line reveals that group
 * there (Agents › Live when the pane has no tab). Finished-only rosters take no
 * dock space: the line disappears once nothing is live.
 *
 * Owns stream-time polling of get_subagents: lifecycle/progress frames keep
 * the store fresh while agents run, but parked/idle transitions ride the
 * AgentRegistry and emit NO wire frame — without polling, a watchdog-parked
 * agent would show "running" until the next session hydration.
 */

import { Bot, ChevronRight } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTabGuard } from "../../../hooks/use-tab-guard";
import { useT } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { revealSidebarSubagents } from "../../../stores/sidebar-subagents";
import { useSubagentsStore } from "../../../stores/subagents";
import { useUiStore } from "../../../stores/ui";
import { subagentPrimaryLabel } from "../../panels/subagent-graph";
import { buildAgentDockPeek } from "./dock-summary";

/** Poll cadence while a turn streams (covers frame-less parked/idle transitions). */
const STREAM_POLL_MS = 3000;

export function AgentsDockCard({ pollMs = STREAM_POLL_MS }: { pollMs?: number }) {
	const t = useT();
	const { capture, isActive } = useTabGuard();
	const tabId = useRuntimeTabId();
	const subagents = useSubagentsStore(state => state.subagents);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const refresh = useSubagentsStore(state => state.refresh);

	useEffect(() => {
		if (!isStreaming) return;
		const timer = setInterval(() => {
			// A poll resolving after a tab/session switch must not paint this
			// tab's agents over the new foreground session — the guard is
			// re-checked inside the store AFTER the await, before the write.
			const origin = capture();
			if (!isActive(origin)) return;
			void refresh({ expect: () => isActive(origin) });
		}, pollMs);
		return () => clearInterval(timer);
	}, [capture, isActive, isStreaming, pollMs, refresh]);

	const peek = useMemo(() => buildAgentDockPeek([...subagents.values()]), [subagents]);
	if (peek.running === 0) return null;

	const counts = [
		t("dock.agents.running", { count: peek.running }),
		peek.done > 0 && t("dock.agents.done", { count: peek.done }),
		peek.failed > 0 && t("dock.agents.failed", { count: peek.failed }),
	]
		.filter(Boolean)
		.join(" · ");
	const latestTitle = peek.latest ? subagentPrimaryLabel(peek.latest) : undefined;
	// The primary label falls back to the agent type; don't print it twice.
	const latestLabel =
		peek.latest && latestTitle !== peek.latest.agent ? `${peek.latest.agent} · ${latestTitle}` : latestTitle;

	const reveal = () => {
		if (tabId) revealSidebarSubagents(tabId);
		else useUiStore.getState().openAgents("live");
	};

	return (
		<button
			aria-label={`${t("dock.agents")}: ${counts}. ${t("dock.agents.show")}`}
			className="omp-fade-up flex min-h-10 w-full shrink-0 items-center gap-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) px-3 py-1 text-left transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-hover) focus-visible:outline-2 focus-visible:outline-(--sc-accent)"
			data-testid="agents-dock-line"
			onClick={reveal}
			title={t("dock.agents.show")}
			type="button"
		>
			<Bot aria-hidden="true" className="shrink-0 text-(--sc-text-muted)" size={16} />
			<span className="shrink-0 text-sc-md font-medium whitespace-nowrap text-(--sc-text)">{t("dock.agents")}</span>
			<span className="shrink-0 text-sc-sm tabular-nums text-(--sc-text-muted)">{counts}</span>
			<span className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text-secondary)">{latestLabel}</span>
			<ChevronRight aria-hidden="true" className="shrink-0 text-(--sc-text-subtle)" size={14} />
		</button>
	);
}
