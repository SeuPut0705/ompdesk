/**
 * Agents dock chip: while subagents run, a compact count chip beside the todo
 * card (alone and left-aligned when there is none) — icon, running count,
 * spinner; the full running/done/failed breakdown rides on the tooltip and
 * accessible name. The roster itself lives in the sidebar, nested under its
 * session; clicking the chip reveals that group there (Agents › Live when the
 * pane has no tab). Finished-only rosters take no dock space: the chip
 * disappears once nothing is live.
 *
 * Owns stream-time polling of get_subagents: lifecycle/progress frames keep
 * the store fresh while agents run, but parked/idle transitions ride the
 * AgentRegistry and emit NO wire frame — without polling, a watchdog-parked
 * agent would show "running" until the next session hydration.
 */

import { Bot } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTabGuard } from "../../../hooks/use-tab-guard";
import { useT } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { revealSidebarSubagents } from "../../../stores/sidebar-subagents";
import { useSubagentsStore } from "../../../stores/subagents";
import { useUiStore } from "../../../stores/ui";
import { Spinner } from "../../common";
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
	const summary = `${t("dock.agents")}: ${counts}`;

	const reveal = () => {
		if (tabId) revealSidebarSubagents(tabId);
		else useUiStore.getState().openAgents("live");
	};

	return (
		<button
			aria-label={`${summary}. ${t("dock.agents.show")}`}
			className="omp-fade-up sticky top-0 flex h-10.5 shrink-0 items-center gap-1.5 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) px-3 transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-hover) focus-visible:outline-2 focus-visible:outline-(--sc-accent)"
			data-testid="agents-dock-chip"
			onClick={reveal}
			title={`${summary} — ${t("dock.agents.show")}`}
			type="button"
		>
			<Bot aria-hidden="true" className="shrink-0 text-(--sc-text-muted)" size={16} />
			<span className="text-sc-md font-medium whitespace-nowrap text-(--sc-text)">{t("dock.agents")}</span>
			<span className="text-sc-sm font-medium tabular-nums text-(--sc-text-muted)">{peek.running}</span>
			<Spinner className="inline-flex shrink-0" size="sm" />
		</button>
	);
}
