/**
 * The side panel's Subagent view: one subagent's live transcript next to the
 * session, opened by dragging its sidebar row onto a pane or from the row's
 * menu. Panes are tabs main owns, each with its own omp, so a subagent never
 * becomes a pane of its own; its transcript reads through the owning tab's
 * runtime, like the sidebar's sheet, and stays put while another tab is in
 * front. The transcript is the main one's own components at the panel's width
 * (`SubagentTranscript`); the header is one line (agent and model mark, then
 * status, tokens, clock and the open/stop/copy icons); while the agent runs,
 * the footer steers it with the composer's look.
 */

import { Bot, Maximize2, Square } from "lucide-react";
import { useCallback, useState } from "react";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { cx, formatElapsed, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { SessionRuntimeProvider, useTabSessionRuntime } from "../../stores/session-runtime-context";
import { useSubagentsStore } from "../../stores/subagents";
import type { PanelSubagent } from "../../stores/ui";
import { CopyButton, EmptyState, IconButton } from "../common";
import { ProviderMark } from "../settings/providers/ProviderMark";
import { SubagentTranscript } from "./SubagentTranscript";
import { isSteerableSubagent, SteerSubagentForm, SubagentTranscriptSheet } from "./SubagentTranscriptSheet";
import { runSubagentAction } from "./subagent-actions";
import {
	isLiveSubagentStatus,
	type StatusMeta,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
} from "./subagent-graph";
import { transcriptToText } from "./subagent-transcript-text";
import { type SubagentTranscriptState, useSubagentTranscript } from "./use-subagent-transcript";

/** Status dot color by the shared status presentation; only state carries color. */
const DOT_CLASS: Record<StatusMeta["variant"], string> = {
	default: "bg-(--sc-text-subtle)",
	accent: "bg-(--sc-accent)",
	info: "bg-(--sc-info)",
	success: "bg-(--sc-success)",
	error: "bg-(--sc-danger)",
	warning: "bg-(--sc-warning)",
	muted: "bg-(--sc-text-subtle)",
};

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

/** `anthropic/claude-sonnet-4-5` → the provider whose mark stands for the model. */
function modelProvider(model: string | undefined): { id: string; name: string } | null {
	const id = model?.includes("/") ? model.slice(0, model.indexOf("/")) : "";
	return id ? { id, name: id } : null;
}

function SubagentHeader({
	agent,
	transcript,
	onOpenFull,
}: {
	agent: SubagentSnapshot;
	transcript: SubagentTranscriptState;
	onOpenFull: () => void;
}) {
	const t = useT();
	const rpc = useTabRpc();
	const refresh = useSubagentsStore(s => s.refresh);
	const live = isLiveSubagentStatus(agent.status);
	const now = useNowTick(live);
	const [stopping, setStopping] = useState(false);
	const meta = statusMeta(agent.status);
	const status = t(meta.labelKey);
	const model = agent.progress?.resolvedModel;
	const provider = modelProvider(model);
	const label = subagentPrimaryLabel(agent);
	const elapsed = subagentElapsedMs(agent, now);
	const tokens = agent.progress?.tokens ?? 0;
	const stoppable = isSteerableSubagent(agent);
	const stop = useCallback(async () => {
		setStopping(true);
		try {
			if (await runSubagentAction(rpc, agent.id, "abort", t)) void refresh();
		} finally {
			setStopping(false);
		}
	}, [rpc, agent.id, t, refresh]);

	return (
		<div className="omp-subagent-header flex min-h-(--sc-space-10) shrink-0 items-center gap-2 border-b border-(--sc-divider) py-1.5 pr-1.5 pl-3">
			<div
				className="flex min-w-0 flex-1 items-center gap-2"
				title={[agent.agent, label, model].filter(Boolean).join("\n")}
			>
				{provider ? (
					<ProviderMark className="size-4" provider={provider} />
				) : (
					<Bot aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
				)}
				<span className="min-w-0 truncate text-sc-sm">
					<span className="font-medium text-(--sc-text)">{agent.agent}</span>
					{label !== agent.agent ? <span className="text-(--sc-text-muted)"> · {label}</span> : null}
				</span>
			</div>
			<div
				className="flex shrink-0 items-center gap-2 text-sc-xs text-(--sc-text-muted) tabular-nums"
				data-subagent-status={agent.status}
			>
				<span className="flex items-center gap-1.5" title={status}>
					<span aria-hidden className={cx("size-1.5 rounded-full", DOT_CLASS[meta.variant])} />
					<span className="omp-subagent-header-status-label">{status}</span>
				</span>
				{tokens > 0 ? (
					<span
						className="omp-subagent-header-tokens"
						title={t("workBoard.tokens", { tokens: formatTokens(tokens) })}
					>
						{formatTokens(tokens)}
					</span>
				) : null}
				{elapsed !== null && elapsed >= 1000 ? <span>{formatElapsed(elapsed)}</span> : null}
			</div>
			<div className="no-drag flex shrink-0 items-center gap-0.5">
				<IconButton icon={<Maximize2 />} label={t("panel.subagent.openFull")} onClick={onOpenFull} size="sm" />
				{stoppable ? (
					<IconButton
						icon={<Square />}
						label={t("sidebar.subagents.stop")}
						loading={stopping}
						onClick={() => void stop()}
						size="sm"
					/>
				) : null}
				<CopyButton
					label={t("panel.subagent.copy")}
					text={() =>
						transcriptToText(transcript.messages, {
							user: t("panel.subagent.copyTask"),
							assistant: agent.agent,
						})
					}
				/>
			</div>
		</div>
	);
}

function SubagentView({ agent }: { agent: SubagentSnapshot }) {
	const transcript = useSubagentTranscript(agent);
	const [full, setFull] = useState(false);
	return (
		<div className="omp-subagent-view flex min-h-0 flex-1 flex-col" data-panel-subagent={agent.id}>
			<SubagentHeader agent={agent} onOpenFull={() => setFull(true)} transcript={transcript} />
			<SubagentTranscript agent={agent} transcript={transcript} />
			{isSteerableSubagent(agent) && (
				<div className="shrink-0 px-3 pt-1 pb-3">
					<SteerSubagentForm agent={agent} key={agent.id} />
				</div>
			)}
			<SubagentTranscriptSheet agent={full ? agent : null} onClose={() => setFull(false)} />
		</div>
	);
}

function SubagentById({ agentId }: { agentId: string }) {
	const agent = useSubagentsStore(s => s.subagents.get(agentId));
	if (!agent) return <Gone />;
	// One view per agent: switching agents starts its transcript and scroll afresh.
	return <SubagentView agent={agent} key={agent.id} />;
}

export function SubagentPanel({ subagent }: { subagent: PanelSubagent | null }) {
	const runtime = useTabSessionRuntime(subagent?.tabId ?? null);
	if (!subagent || !runtime) return <Gone />;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<SubagentById agentId={subagent.agentId} />
		</SessionRuntimeProvider>
	);
}
