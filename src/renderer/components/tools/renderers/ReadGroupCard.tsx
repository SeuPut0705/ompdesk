/**
 * Grouped read-tool card (TUI read-tool-group parity): one collapsible read
 * renders inline as a step row ("Read  a.ts  src"); consecutive reads fold
 * into one "Read  3 files · a.ts, b.ts, c.ts" row with same-file selector
 * merges. Per-call status resolves from the tools store (same source as
 * ToolCard). Expanding reveals the individual read rows with full content.
 */

import { ChevronRight, FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { basename, cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { mergeReadGroupEntries, type ReadGroupEntry, type ReadGroupUsage } from "../../../lib/read-group";
import { selectToolEntry, useToolsStore } from "../../../stores/tools";
import { UsageRow } from "../../chat/UsageRow";
import {
	AFTER_INTENT_CLASS,
	type RunningIndicator,
	type StepThoughts,
	ThoughtCount,
	TOOL_ROW_CLASS,
	ToolCard,
	ToolPathTarget,
	ToolStatusIcon,
	useSliverGuard,
} from "../ToolCard";

function statusOf(status: string | undefined): "pending" | "success" | "error" | "aborted" {
	if (status === "error") return "error";
	if (status === "aborted") return "aborted";
	if (status === "pending" || status === "running") return "pending";
	return "success";
}

export function ReadGroupCard({
	entries,
	forceOpen = false,
	inset,
	intent,
	runningIndicator = "spinner",
	showIntent = true,
	thoughts,
	usage,
}: {
	entries: ReadGroupEntry[];
	/** Opens the group (again) whenever this changes to something truthy: a work card showing a failed or asked-for read. */
	forceOpen?: boolean | object;
	inset?: boolean;
	/** What every read in it was for: the row leads with it, the files follow muted. */
	intent?: string;
	runningIndicator?: RunningIndicator;
	/** Its reads may lead with their own intents; off under a row that already says it. */
	showIntent?: boolean;
	/** The thoughts just before the reads, folded into the row. */
	thoughts?: StepThoughts;
	/** Usage carried from fully-consumed assistant turns (TUI parity). */
	usage?: ReadGroupUsage[];
}) {
	const t = useT();
	const [open, setOpen] = useState(forceOpen !== false);
	useEffect(() => {
		if (forceOpen) setOpen(true);
	}, [forceOpen]);
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
	const rowRef = useRef<HTMLButtonElement>(null);
	useSliverGuard(rowRef, rows.map(row => `${row.path}:${row.selector ?? ""}`).join("\n"));

	return (
		<div className={cx("omp-read-group", pad)}>
			{/* controls-ok: the omp-read-group-header class draws the whole control */}
			<button
				ref={rowRef}
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				className={cx("omp-read-group-header", TOOL_ROW_CLASS)}
			>
				<ToolStatusIcon kindIcon={<FileText />} runningIndicator={runningIndicator} state={state} />
				{intent ? <span className="sr-only">{`${t("tools.label.read")}, `}</span> : null}
				<span
					className={cx(
						intent ? "min-w-0 truncate" : "shrink-0",
						"font-medium",
						state === "error" ? "text-(--sc-danger)" : "text-(--sc-text-secondary)",
					)}
					title={intent}
				>
					{intent ?? t("tools.label.read")}
				</span>
				{single ? (
					<ToolPathTarget
						afterIntent={!!intent}
						path={single.path}
						suffix={single.selector ? `:${single.selector}` : undefined}
					/>
				) : (
					<span
						className={cx(
							"omp-tool-summary min-w-0 truncate",
							intent ? AFTER_INTENT_CLASS : "text-(--sc-text-muted)",
						)}
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
				) : state === "running" ? (
					<span className="sr-only">{t("chat.exec.running")}</span>
				) : (
					<span className="sr-only">{t("tools.status.done")}</span>
				)}
				{thoughts ? <ThoughtCount count={thoughts.count} /> : null}
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
					{thoughts?.body}
					{entries.map(entry => (
						<ToolCard
							key={entry.toolKey}
							toolCallId={entry.toolKey}
							toolName="read"
							args={entry.args}
							runningIndicator="dot"
							showIntent={showIntent && !intent}
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
