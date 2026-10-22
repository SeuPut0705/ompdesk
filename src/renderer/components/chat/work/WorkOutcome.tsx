import { ChevronRight, FilePen, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatDuration } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";
import { ToolImage } from "../../tools/media/ToolImage";
import { ChatMedia } from "../../tools/media/ToolMedia";
import { useRunOutcome } from "./use-work-run";
import { WorkStatus } from "./WorkStatus";
import { projectPath } from "./work-run";
import type { WorkCommandOutcome } from "./work-view";

/** Rows a list shows before folding the rest behind "N more". */
const VISIBLE_ROWS = 4;
const VISIBLE_IMAGES = 4;

function commandFailed(command: WorkCommandOutcome): boolean {
	return !command.interrupted && (command.failed || (command.exitCode !== null && command.exitCode !== 0));
}

/**
 * What a finished run produced, main agent and subagents alike: failed and
 * stopped commands first (their output is what needs reading), then changed
 * files with their line counts and the remaining commands, plus the pictures it
 * made or looked at. The counts live once, in the card's head; agent
 * conclusions live on their lanes.
 */
export function WorkOutcome({
	toolCallIds,
	stoppedAt,
}: {
	toolCallIds: readonly string[];
	/** Timestamp of stock's empty aborted reply (a stop during tool execution). */
	stoppedAt?: number;
}) {
	const t = useT();
	const cwd = useSessionStore(state => state.cwd);
	const detail = useUiStore(s => s.transcriptDetail);
	const { outcome, loading, error } = useRunOutcome(toolCallIds, stoppedAt);
	const [showAll, setShowAll] = useState(false);
	const [showAllImages, setShowAllImages] = useState(false);
	const [openOutput, setOpenOutput] = useState<number[]>([]);
	const images = showAllImages ? outcome.images : outcome.images.slice(0, VISIBLE_IMAGES);
	const imageRow =
		outcome.media.length || outcome.images.length ? (
			<div className="omp-work-images" aria-label={t("chat.work.images")}>
				{outcome.media.map(item => (
					<ChatMedia key={item.path} kind={item.kind} path={item.path} />
				))}
				{images.map(image => (
					<figure key={image.key} className="omp-work-image" title={image.label}>
						<ToolImage src={image.src} path={image.path} loading="lazy" decoding="async" />
						<figcaption className="font-mono">{image.caption}</figcaption>
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
	if (!outcome.files.length && !outcome.commands.length) return imageRow;
	// Indexes into outcome.commands keep each row's identity stable across the reorder.
	const commandRows = outcome.commands.map((command, index) => ({ command, index }));
	const attention = commandRows.filter(({ command }) => commandFailed(command) || command.interrupted);
	const quiet = commandRows.filter(({ command }) => !commandFailed(command) && !command.interrupted);
	const rows = outcome.files.length + outcome.commands.length;
	let budget = showAll ? Number.POSITIVE_INFINITY : VISIBLE_ROWS;
	const take = <T,>(items: readonly T[]): readonly T[] => {
		const slice = items.slice(0, Math.max(0, budget));
		budget -= slice.length;
		return slice;
	};
	const firstCommands = take(attention);
	const files = take(outcome.files);
	const restCommands = take(quiet);
	const renderCommand = ({ command, index }: { command: WorkCommandOutcome; index: number }) => {
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
		const open = openOutput.includes(index);
		return (
			<li
				key={`command-${index}`}
				data-kind="command"
				data-failed={failed}
				data-interrupted={command.interrupted || undefined}
			>
				<WorkStatus state={stoppedRow ? "stopped" : failed ? "failed" : "complete"} label={status} motion={false} />
				{command.output ? (
					// A stopped command keeps what it printed before the stop one click away.
					<button
						type="button"
						className="omp-work-outcome-main omp-work-outcome-toggle font-mono"
						aria-expanded={open}
						title={command.command}
						onClick={() =>
							setOpenOutput(current => (open ? current.filter(value => value !== index) : [...current, index]))
						}
					>
						{command.command}
					</button>
				) : (
					<span className="omp-work-outcome-main font-mono" title={command.command}>
						{command.command}
					</span>
				)}{" "}
				{meta.length ? (
					<span className="omp-work-outcome-meta" title={meta.join(" · ")}>
						{meta.join(" · ")}
					</span>
				) : null}
				{open && command.output ? <pre className="omp-work-outcome-output">{command.output}</pre> : null}
			</li>
		);
	};
	return (
		<>
			<details className="omp-work-outcome" open={detail === "full"}>
				<summary>
					<ChevronRight aria-hidden className="omp-disclosure-chevron omp-work-outcome-chevron" />
					<span className="omp-work-outcome-title">{t("chat.work.outcome")}</span>
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
					{firstCommands.map(renderCommand)}
					{files.map((file, index) => {
						const path = projectPath(file.path, cwd);
						return (
							<li key={`${file.path}-${index}`} data-kind="file">
								{file.deleted ? (
									<Trash2 aria-hidden className="omp-work-outcome-icon" />
								) : (
									<FilePen aria-hidden className="omp-work-outcome-icon" />
								)}
								<span className="omp-work-outcome-main font-mono" title={path}>
									{path}
								</span>{" "}
								{file.deleted ? (
									<span className="omp-work-outcome-meta">{t("chat.work.deleted")}</span>
								) : file.added !== undefined ? (
									<span className="omp-work-diff omp-work-outcome-meta">
										<span data-diff="added">+{file.added}</span>{" "}
										<span data-diff="removed">−{file.removed}</span>
									</span>
								) : null}
							</li>
						);
					})}
					{restCommands.map(renderCommand)}
				</ul>
				{rows > VISIBLE_ROWS ? (
					<button
						type="button"
						className="omp-work-outcome-more"
						aria-expanded={showAll}
						onClick={() => setShowAll(value => !value)}
					>
						{showAll ? t("chat.work.fewer") : t("chat.work.more", { count: rows - VISIBLE_ROWS })}
					</button>
				) : null}
			</details>
			{imageRow}
		</>
	);
}
