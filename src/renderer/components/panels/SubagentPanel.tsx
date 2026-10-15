/**
 * The side panel's Subagent view: one subagent's live transcript next to the
 * session, opened by dragging its sidebar row onto a pane or from the row's
 * menu. Panes are tabs main owns, each with its own omp, so a subagent never
 * becomes a pane of its own; its transcript reads through the owning tab's
 * runtime, like the sidebar's sheet, and stays put while another tab is in
 * front. While it runs, the footer steers it.
 */

import { Bot } from "lucide-react";
import { useT } from "../../lib/i18n";
import { SessionRuntimeProvider, useTabSessionRuntime } from "../../stores/session-runtime-context";
import { useSubagentsStore } from "../../stores/subagents";
import type { PanelSubagent } from "../../stores/ui";
import { EmptyState } from "../common";
import { PanelToolbar } from "./PanelChrome";
import { SubagentTranscript } from "./SubagentTranscript";
import { isSteerableSubagent, SteerSubagentForm } from "./SubagentTranscriptSheet";
import { statusMeta, subagentPrimaryLabel } from "./subagent-graph";

function Gone() {
	const t = useT();
	return (
		<EmptyState
			className="flex-1"
			description={t("panel.subagent.goneHint")}
			icon={<Bot />}
			size="sm"
			title={t("panel.subagent.gone")}
		/>
	);
}

function SubagentView({ agentId }: { agentId: string }) {
	const t = useT();
	const agent = useSubagentsStore(s => s.subagents.get(agentId));
	if (!agent) return <Gone />;
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-panel-subagent={agent.id}>
			<PanelToolbar className="flex-nowrap">
				<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text)" title={agent.agent}>
					{subagentPrimaryLabel(agent)}
				</span>
				<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">
					{agent.agent} · {t(statusMeta(agent.status).labelKey)}
				</span>
			</PanelToolbar>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
				<SubagentTranscript agent={agent} />
			</div>
			{isSteerableSubagent(agent) && (
				<div className="shrink-0 border-t border-(--sc-divider) px-3 py-2">
					<SteerSubagentForm agent={agent} key={agent.id} />
				</div>
			)}
		</div>
	);
}

export function SubagentPanel({ subagent }: { subagent: PanelSubagent | null }) {
	const runtime = useTabSessionRuntime(subagent?.tabId ?? null);
	if (!subagent || !runtime) return <Gone />;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<SubagentView agentId={subagent.agentId} />
		</SessionRuntimeProvider>
	);
}
