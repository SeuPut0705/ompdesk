/**
 * Grouped read-tool card (TUI read-tool-group parity): one collapsible read
 * renders inline as a step row ("Read  a.ts  src"); consecutive reads fold
 * into one "Read  3 files · a.ts, b.ts, c.ts" row with same-file selector
 * merges. Per-call status resolves from the tools store (same source as
 * ToolCard). Expanding reveals the individual read rows with full content.
 */

import { ChevronRight, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { basename, cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { mergeReadGroupEntries, type ReadGroupEntry, type ReadGroupUsage } from "../../../lib/read-group";
import { selectToolEntry, useToolsStore } from "../../../stores/tools";
import { UsageRow } from "../../chat/UsageRow";
import { type RunningIndicator, TOOL_ROW_CLASS, ToolCard, ToolPathTarget, ToolStatusIcon } from "../ToolCard";

function statusOf(status: string | undefined): "pending" | "success" | "error" | "aborted" {
	if (status === "error") return "error";
	if (status === "aborted") return "aborted";
	if (status === "pending" || status === "running") return "pending";
	return "success";
}

export function ReadGroupCard({
	entries,
	inset,
	runningIndicator = "spinner",
	usage,
}: {
	entries: ReadGroupEntry[];
	inset?: boolean;
	runningIndicator?: RunningIndicator;
	/** Usage carried from fully-consumed assistant turns (TUI parity). */
	usage?: ReadGroupUsage[];
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const rows = mergeReadGroupEntries(entries);
	const pad = inset ? "py-0.5" : "ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-0.5";

	// One primitive snapshot for this group's calls: unrelated tool events
	// never re-render historical read groups.
	const statusKey = useToolsStore(s =>
		entries.map(entry => statusOf(selectToolEntry(s, entry.toolKey)?.status)).join("|"),
	);
	const statuses = useMemo(() => {
		const values = statusKey.split("|") as Array<"pending" | "success" | "error" | "aborted">;
		return new Map(entries.map((entry, index) => [entry.toolKey, values[index] ?? "success"]));
	}, [entries, statusKey]);
	const anyPending = entries.some(entry => statuses.get(entry.toolKey) === "pending");
	const anyError = entries.some(entry => statuses.get(entry.toolKey) === "error");
	const anyAborted = entries.some(entry => statuses.get(entry.toolKey) === "aborted");
	const state = anyPending ? "running" : anyError ? "error" : anyAborted ? "aborted" : "done";
	const single = rows.length === 1 ? rows[0] : undefined;

	return (
		<div className={cx("omp-read-group", pad)}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				className={cx("omp-read-group-header", TOOL_ROW_CLASS)}
			>
				<ToolStatusIcon kindIcon={<FileText />} runningIndicator={runningIndicator} state={state} />
				<span
					className={cx(
						"shrink-0 font-medium",
						state === "error" ? "text-(--sc-danger)" : "text-(--sc-text-secondary)",
					)}
				>
					{t("tools.label.read")}
				</span>
				{single ? (
					<ToolPathTarget path={single.path} suffix={single.selector ? `:${single.selector}` : undefined} />
				) : (
					<span
						className="omp-tool-summary min-w-0 truncate text-(--sc-text-muted)"
						title={rows.map(row => row.path).join("\n")}
					>
						{t("readGroup.files", { count: rows.length })}
						<span className="ms-1.5 font-mono text-(--sc-text-subtle)">
							{rows.map(row => basename(row.path)).join(", ")}
						</span>
					</span>
				)}
				{state === "error" ? (
					<span className="shrink-0 text-sc-xs font-medium text-(--sc-danger)">{t("tools.status.failed")}</span>
				) : state === "aborted" ? (
					<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{t("tools.status.interrupted")}</span>
				) : null}
				<ChevronRight
					aria-hidden
					className={cx(
						"omp-disclosure-chevron size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)",
						open && "rotate-90",
					)}
				/>
			</button>
			{open && (
				<div className="omp-read-group-body">
					{entries.map(entry => (
						<ToolCard
							key={entry.toolKey}
							toolCallId={entry.toolKey}
							toolName="read"
							args={entry.args}
							runningIndicator="dot"
						/>
					))}
				</div>
			)}
			{usage?.map((item, index) => (
				<UsageRow key={index} message={item} />
			))}
		</div>
	);
}
