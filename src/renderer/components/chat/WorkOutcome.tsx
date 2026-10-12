import { Bot, ChevronRight, FilePen, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSessionRuntime } from "../../stores/session-runtime-context";
import { type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import { selectToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { ZoomableImage } from "../common/ZoomableImage";
import { WorkStatus } from "./WorkStatus";
import { agentResultSummary, type WorkEvidence, workOutcomes } from "./work-view";

/** Rows a list shows before folding the rest behind "N more". */
const VISIBLE_ROWS = 4;
const VISIBLE_IMAGES = 4;

function plural(count: number): string {
	return count === 1 ? "" : "s";
}

/**
 * What a finished group produced: changed files with their line counts, the
 * commands it ran (who ran them, how they ended, how long they took), the
 * pictures it made or looked at (always visible, they open full size) and, where
 * no agent lanes already show them, each agent's conclusion. The summary line
 * states only non-zero facts; the lists open on demand.
 */
export function WorkOutcome({
	toolCallIds,
	showConclusions = true,
	stoppedAt,
}: {
	toolCallIds: readonly string[];
	showConclusions?: boolean;
	/** Timestamp of stock's empty aborted reply (a stop during tool execution). */
	stoppedAt?: number;
}) {
	const t = useT();
	const cwd = useSessionStore(state => state.cwd);
	const runtime = useSessionRuntime();
	const tools = (runtime?.stores.get("tools") as StoreApi<ToolsStore> | undefined) ?? useToolsStore;
	const subagents = (runtime?.stores.get("subagents") as StoreApi<SubagentsStore> | undefined) ?? useSubagentsStore;
	const belongs = (id: string | undefined) => !!id && toolCallIds.includes(tools.getState().entryKeyForCallId(id));
	const agentKey = useFrameSelector(subagents, state =>
		[...state.subagents.values()]
			.filter(node => belongs(node.parentToolCallId))
			.map(
				node =>
					`${node.id}:${node.status}:${node.progress?.toolCount ?? 0}:${agentResultSummary({ ...node.progress }) ?? ""}:${state.surfaces.get(node.id)?.getState().finishedVersion ?? 0}`,
			)
			.join("|"),
	);
	const detail = useUiStore(s => s.transcriptDetail);
	const key = useFrameSelector(tools, state =>
		toolCallIds
			.map(id => {
				const entry = selectToolEntry(state, id);
				return `${id}:${entry?.status}:${entry?.endTime}`;
			})
			.join("|"),
	);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		void agentKey;
		const missing = [...subagents.getState().subagents.values()].filter(
			node =>
				!!node.parentToolCallId &&
				toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)) &&
				node.status !== "running" &&
				node.status !== "pending",
		);
		if (!missing.length) return;
		setLoading(true);
		void Promise.all(missing.map(node => subagents.getState().hydrateSurface(node.id)))
			.catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setLoading(false));
	}, [agentKey, subagents, tools, toolCallIds]);
	const outcome = useMemo(() => {
		void key;
		void agentKey;
		const agents = [...subagents.getState().subagents.values()].filter(
			node =>
				!!node.parentToolCallId && toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)),
		);
		const entries: WorkEvidence[] = toolCallIds.flatMap(id => {
			const entry = selectToolEntry(tools.getState(), id);
			return entry ? [entry] : [];
		});
		for (const agent of agents) {
			for (const entry of subagents.getState().surfaces.get(agent.id)?.getState().finishedTools.values() ?? [])
				entries.push({ entry, agentName: agent.id });
		}
		return workOutcomes(entries, agents, stoppedAt, cwd);
	}, [key, agentKey, tools, subagents, toolCallIds, stoppedAt, cwd]);
	const [showAll, setShowAll] = useState(false);
	const [showAllImages, setShowAllImages] = useState(false);
	const images = showAllImages ? outcome.images : outcome.images.slice(0, VISIBLE_IMAGES);
	const conclusions = showConclusions ? outcome.conclusions : [];
	const imageRow = outcome.images.length ? (
		<div className="omp-work-images" aria-label={t("chat.work.images")}>
			{images.map(image => (
				<figure key={image.src} className="omp-work-image" title={image.label}>
					<ZoomableImage alt={image.label} src={image.src} loading="lazy" decoding="async" />
					<figcaption className="font-mono">{image.label.split("/").at(-1)}</figcaption>
				</figure>
			))}
			{outcome.images.length > VISIBLE_IMAGES ? (
				<button
					type="button"
					className="omp-work-outcome-more"
					aria-expanded={showAllImages}
					onClick={() => setShowAllImages(value => !value)}
				>
					{showAllImages
						? t("chat.work.fewer")
						: t("chat.work.moreImages", { count: outcome.images.length - VISIBLE_IMAGES })}
				</button>
			) : null}
		</div>
	) : null;
	if (!outcome.files.length && !outcome.commands.length && !conclusions.length) return imageRow;
	const commandFailed = (command: (typeof outcome.commands)[number]) =>
		!command.interrupted && (command.failed || (command.exitCode !== null && command.exitCode !== 0));
	const failedCommands = outcome.commands.filter(commandFailed).length;
	const added = outcome.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
	const removed = outcome.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
	const hasStats = outcome.files.some(file => file.added !== undefined);
	const rows = outcome.files.length + outcome.commands.length + conclusions.length;
	const limit = showAll ? Number.POSITIVE_INFINITY : VISIBLE_ROWS;
	let budget = limit;
	const take = <T,>(items: readonly T[]): readonly T[] => {
		const slice = items.slice(0, Math.max(0, budget));
		budget -= slice.length;
		return slice;
	};
	const files = take(outcome.files);
	const commands = take(outcome.commands);
	const shownConclusions = take(conclusions);
	return (
		<>
			<details className="omp-work-outcome" open={detail === "full"}>
				<summary>
					<ChevronRight aria-hidden className="omp-disclosure-chevron omp-work-outcome-chevron" />
					<span className="omp-work-outcome-title">{t("chat.work.outcome")}</span>
					{outcome.files.length ? (
						<span className="omp-work-fact">
							{t("chat.work.filesChanged", {
								count: outcome.files.length,
								plural: plural(outcome.files.length),
							})}
							{hasStats ? (
								<span className="omp-work-diff">
									{" "}
									<span data-diff="added">+{added}</span> <span data-diff="removed">−{removed}</span>
								</span>
							) : null}
						</span>
					) : null}
					{outcome.commands.length ? (
						<span className="omp-work-fact">
							{t("chat.work.commandsRun", {
								count: outcome.commands.length,
								plural: plural(outcome.commands.length),
							})}
						</span>
					) : null}
					{failedCommands ? (
						<span className="omp-work-fact" data-tone="danger">
							{t("chat.work.commandsFailed", { count: failedCommands })}
						</span>
					) : null}
					{conclusions.length ? (
						<span className="omp-work-fact">
							{t("chat.work.agentsDone", { count: conclusions.length, plural: plural(conclusions.length) })}
						</span>
					) : null}
				</summary>
				{loading ? (
					<div className="omp-live-work-calm" role="status">
						{t("subagent.loadingTranscript")}
					</div>
				) : null}
				{error ? (
					<div className="omp-live-work-calm" role="alert">
						{t("subagent.transcriptFailed")}: {error}
					</div>
				) : null}
				<ul className="omp-work-outcome-list">
					{files.map((file, index) => (
						<li key={`${file.path}-${index}`} data-kind="file">
							{file.deleted ? (
								<Trash2 aria-hidden className="omp-work-outcome-icon" />
							) : (
								<FilePen aria-hidden className="omp-work-outcome-icon" />
							)}
							<span className="omp-work-outcome-main font-mono" title={file.path}>
								{file.path}
							</span>{" "}
							{file.deleted ? (
								<span className="omp-work-outcome-meta">{t("chat.work.deleted")}</span>
							) : file.added !== undefined ? (
								<span className="omp-work-diff omp-work-outcome-meta">
									<span data-diff="added">+{file.added}</span> <span data-diff="removed">−{file.removed}</span>
								</span>
							) : null}
						</li>
					))}
					{commands.map((command, index) => {
						const failed = commandFailed(command);
						const stoppedRow = command.unknown || command.interrupted;
						const status = command.interrupted
							? t("tools.status.interrupted")
							: command.unknown
								? t("chat.work.unknown")
								: failed
									? t("chat.work.fail")
									: t(command.exitCode === null ? "chat.work.succeeded" : "chat.work.pass");
						const meta = [
							command.agentName,
							stoppedRow ? status : null,
							failed && command.exitCode !== null && command.exitCode !== 0
								? t("chat.work.exit", { code: command.exitCode })
								: null,
							command.durationMs !== undefined ? formatDuration(command.durationMs) : null,
						].filter(Boolean);
						return (
							<li key={`${command.command}-${index}`} data-kind="command" data-failed={failed}>
								<WorkStatus
									state={stoppedRow ? "stopped" : failed ? "failed" : "complete"}
									label={status}
									motion={false}
								/>
								<span className="omp-work-outcome-main font-mono" title={command.command}>
									{command.command}
								</span>{" "}
								{meta.length ? (
									<span className="omp-work-outcome-meta" title={meta.join(" · ")}>
										{meta.join(" · ")}
									</span>
								) : null}
							</li>
						);
					})}
					{shownConclusions.map((agent, index) => (
						<li key={`${agent.name}-${index}`} data-kind="agent">
							<Bot aria-hidden className="omp-work-outcome-icon" />
							<span className="omp-work-outcome-main" title={`${agent.name}: ${agent.summary}`}>
								<span className="omp-work-outcome-agent">{agent.name}</span> {agent.summary}
							</span>
						</li>
					))}
				</ul>
				{rows > VISIBLE_ROWS ? (
					<button type="button" className="omp-work-outcome-more" onClick={() => setShowAll(value => !value)}>
						{showAll ? t("chat.work.fewer") : t("chat.work.more", { count: rows - VISIBLE_ROWS })}
					</button>
				) : null}
			</details>
			{imageRow}
		</>
	);
}
