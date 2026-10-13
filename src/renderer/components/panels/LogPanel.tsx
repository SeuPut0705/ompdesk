/**
 * Log panel: subscribes to batched log:line IPC, keeps a 1000-line ring buffer,
 * with search filtering, level filter, and pin-aware auto-scroll.
 */

import { ArrowDown, Copy, Download, RotateCw, ScrollText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogBatch } from "../../../shared/ipc-types";
import { errorDetail } from "../../lib/error-detail";
import { copyText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { Button, EmptyState, IconButton, SearchField, Select } from "../common";
import { PanelToolbar } from "./PanelChrome";

const MAX_LINES = 1000;

type LogLevel = "info" | "warn" | "error" | "other";

interface LogLine {
	seq: number;
	text: string;
	level: LogLevel;
}

const LEVEL_CLASS: Record<LogLevel, string> = {
	info: "text-(--sc-text-muted)",
	warn: "text-(--sc-warning)",
	error: "text-(--sc-danger)",
	other: "text-(--sc-text-subtle)",
};

const LEVEL_LABEL_KEY = {
	all: "logPanel.level.all",
	info: "logPanel.level.info",
	warn: "logPanel.level.warn",
	error: "logPanel.level.error",
} as const;

function detectLevel(text: string): LogLevel {
	const lower = text.toLowerCase();
	if (/\b(error|err!|fatal)\b/.test(lower)) return "error";
	if (/\b(warn|warning)\b/.test(lower)) return "warn";
	if (/\binfo\b/.test(lower)) return "info";
	return "other";
}

export function LogPanel() {
	const t = useT();
	const [lines, setLines] = useState<LogLine[]>([]);
	const [query, setQuery] = useState("");
	const [levelFilter, setLevelFilter] = useState<"all" | LogLevel>("all");
	const [pinned, setPinned] = useState(true);
	const scrollRef = useRef<HTMLDivElement>(null);

	/** Snapshot load failure (raw detail); a failed copy is a toast, never this. */
	const [error, setError] = useState<string | null>(null);

	const applyBatch = useCallback((batch: LogBatch): void => {
		setLines(previous => {
			const all = new Map(previous.map(line => [line.seq, line]));
			batch.lines.forEach((text, index) => {
				const seq = batch.nextSequence - batch.lines.length + index;
				all.set(seq, { seq, text, level: detectLevel(text) });
			});
			return [...all.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_LINES);
		});
	}, []);

	const reload = useCallback((): void => {
		setError(null);
		void window.omp.runtime
			.logSnapshot()
			.then(applyBatch)
			.catch(cause => setError(errorDetail(cause)));
	}, [applyBatch]);

	useEffect(() => {
		const unsubscribe = window.omp.events.onLogBatch(applyBatch);
		void reload();
		return unsubscribe;
	}, [applyBatch, reload]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return lines.filter(line => {
			if (levelFilter !== "all" && line.level !== levelFilter) return false;
			return q.length === 0 || line.text.toLowerCase().includes(q);
		});
	}, [lines, query, levelFilter]);

	// Follow the tail whenever pinned and new (filtered) lines render.
	useEffect(() => {
		if (!pinned) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = filtered.length === 0 ? 0 : el.scrollHeight;
	}, [pinned, filtered]);

	const exportLogs = () => {
		const url = URL.createObjectURL(
			new Blob([filtered.map(line => line.text).join("\n")], { type: "text/plain;charset=utf-8" }),
		);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `omp-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
		anchor.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	};

	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
	};

	const jumpToBottom = () => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
		setPinned(true);
	};

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col">
			<PanelToolbar>
				<Select
					value={levelFilter}
					aria-label={t("logPanel.title")}
					controlSize="sm"
					onChange={event => setLevelFilter(event.target.value as "all" | LogLevel)}
					options={(["all", "info", "warn", "error"] as const).map(level => ({
						value: level,
						label: t(LEVEL_LABEL_KEY[level]),
					}))}
				/>
				{/* The empty state already says there is nothing; a count needs its unit. */}
				{filtered.length > 0 && (
					<span className="text-sc-xs whitespace-nowrap tabular-nums text-(--sc-text-subtle)" data-log-count>
						{t("logPanel.lineCount", { count: filtered.length })}
					</span>
				)}
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<IconButton
						disabled={filtered.length === 0}
						icon={<Copy />}
						label={t("logPanel.copy")}
						onClick={() =>
							void copyText(filtered.map(line => line.text).join("\n")).then(ok => {
								if (!ok) toast({ variant: "error", message: t("copySelector.failed") });
							})
						}
						size="sm"
					/>
					<IconButton
						disabled={filtered.length === 0}
						icon={<Download />}
						label={t("logPanel.export")}
						onClick={exportLogs}
						size="sm"
					/>
				</div>
			</PanelToolbar>
			<div className="px-3 pb-1.5">
				<SearchField
					controlSize="sm"
					label={t("logPanel.searchLabel")}
					onValueChange={setQuery}
					placeholder={t("logPanel.placeholder")}
					value={query}
				/>
				<span className="sr-only">{t("logPanel.scope")}</span>
			</div>
			<div className="relative min-h-0 flex-1">
				<div
					className="h-full overflow-y-auto px-3 py-1 font-mono text-sc-xs leading-(--sc-leading-normal)"
					onScroll={onScroll}
					ref={scrollRef}
				>
					{error ? (
						<div className="flex flex-col items-center gap-2 py-8 text-center font-sans" role="alert">
							<p className="text-sc-sm font-medium text-(--sc-text)">{t("logPanel.loadFailed")}</p>
							<p className="max-w-full font-mono text-sc-xs break-words text-(--sc-text-muted)">{error}</p>
							<Button icon={<RotateCw />} onClick={reload} size="sm" variant="secondary">
								{t("common.retry")}
							</Button>
						</div>
					) : filtered.length === 0 ? (
						<EmptyState
							className="font-sans"
							icon={<ScrollText />}
							size="sm"
							title={lines.length === 0 ? t("logPanel.waiting") : t("logPanel.noMatch")}
							actions={
								lines.length > 0 ? (
									<Button
										size="sm"
										variant="secondary"
										onClick={() => {
											setQuery("");
											setLevelFilter("all");
										}}
									>
										{t("common.clear")}
									</Button>
								) : undefined
							}
						/>
					) : (
						filtered.map(line => (
							<div className={`break-all whitespace-pre-wrap ${LEVEL_CLASS[line.level]}`} key={line.seq}>
								{line.text}
							</div>
						))
					)}
				</div>
				{!pinned && (
					<Button
						className="absolute right-3 bottom-3"
						icon={<ArrowDown />}
						onClick={jumpToBottom}
						size="sm"
						variant="secondary"
					>
						{t("logPanel.latest")}
					</Button>
				)}
			</div>
		</div>
	);
}
