import { AlertTriangle, XCircle } from "lucide-react";
import { useState } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { revealAndFocus } from "../../../lib/reveal-focus";
import { asArray, asNonEmptyString, asRecord } from "../../../lib/wire-value";
import { LinkButton } from "../../common";

/**
 * LSP diagnostics stock attaches to edit/write results and late-diagnostic
 * messages: `FileDiagnosticsResult { server?, messages[], summary, errored,
 * formatter? }` (pi-tui `tools/lsp.ts`). Rows follow stock
 * `native-view.ts` `diagnosticsSection`: most severe first, then line/column,
 * five rows before "+N more", the file named when several files report.
 */
export interface FileDiagnostics {
	path?: string;
	messages: string[];
	summary?: string;
	errored: boolean;
}

/** TUI diagnostic line format: `path:line:col [severity] [source]? message (code)?`. */
const DIAG_LINE_RE = /^(.+?):(\d+):(\d+)\s+\[(\w+)\]\s+(?:\[([^\]]+)\]\s+)?(.+?)(?:\s+\(([^)]+)\))?$/;
/** Rows before "+N more" (stock `DIAGNOSTIC_ROWS`). */
const COLLAPSED_DIAGS = 5;
const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
const SEVERITY_COLOR: Record<string, string> = {
	error: "var(--omp-error)",
	warning: "var(--omp-warning)",
	info: "var(--omp-link)",
};

/** Severity words and the parts of stock's `summarizeDiagnosticMessages` summary (`2 error(s)`), in the UI language. */
const SEVERITY_LABEL_KEYS: Record<string, string> = {
	error: "tools.diagnostics.error",
	warning: "tools.diagnostics.warning",
	info: "tools.diagnostics.info",
	hint: "tools.diagnostics.hint",
};
const SUMMARY_COUNT_KEYS: Record<string, string> = {
	error: "tools.diagnostics.errors",
	warning: "tools.diagnostics.warnings",
	info: "tools.diagnostics.infos",
	hint: "tools.diagnostics.hints",
};
const SUMMARY_PART_RE = /^(\d+) (\w+)\(s\)$/;

interface DiagEntry {
	line: number;
	col: number;
	severity: string;
	source?: string;
	text: string;
	code?: string;
}

type DiagItem = { kind: "diag"; diag: DiagEntry } | { kind: "raw"; text: string };

interface DiagGroup {
	path?: string;
	items: DiagItem[];
}

/** One `FileDiagnosticsResult` from the wire, or undefined when it carries nothing. */
export function asFileDiagnostics(value: unknown, path?: string): FileDiagnostics | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const messages = asArray(record.messages).filter((message): message is string => typeof message === "string");
	return {
		path: asNonEmptyString(record.path) ?? path,
		messages,
		summary: asNonEmptyString(record.summary),
		errored: record.errored === true,
	};
}

/** Every diagnostics record of an edit/write result: the single file's, then each file of a batch. */
export function resultDiagnostics(details: Record<string, unknown> | undefined): FileDiagnostics[] {
	const files: FileDiagnostics[] = [];
	const own = asFileDiagnostics(details?.diagnostics, asNonEmptyString(details?.path));
	if (own) files.push(own);
	for (const entry of asArray(details?.perFileResults)) {
		const record = asRecord(entry);
		const file = asFileDiagnostics(record?.diagnostics, asNonEmptyString(record?.path));
		if (file) files.push(file);
	}
	return files;
}

function diagGroups(files: readonly FileDiagnostics[]): DiagGroup[] {
	const groups: DiagGroup[] = [];
	for (const file of files) {
		if (file.messages.length === 0) continue;
		const diags: DiagEntry[] = [];
		const raws: string[] = [];
		for (const message of file.messages) {
			const match = message.match(DIAG_LINE_RE);
			if (!match) {
				if (message.trim()) raws.push(message.trim());
				continue;
			}
			diags.push({
				line: Number.parseInt(match[2], 10),
				col: Number.parseInt(match[3], 10),
				severity: match[4],
				source: match[5],
				text: match[6],
				code: match[7],
			});
		}
		diags.sort(
			(a, b) =>
				(SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) ||
				a.line - b.line ||
				a.col - b.col ||
				a.text.localeCompare(b.text),
		);
		groups.push({
			path: file.path,
			items: [
				...diags.map((diag): DiagItem => ({ kind: "diag", diag })),
				...raws.map((text): DiagItem => ({ kind: "raw", text })),
			],
		});
	}
	return groups;
}

/** Diagnostic count across files (stock `diagnosticsBadge`), 0 when none. */
export function diagnosticsCount(files: readonly FileDiagnostics[]): number {
	return files.reduce((sum, file) => sum + file.messages.length, 0);
}

/** Grouped diagnostic rows, five before a "+N more" button. File names show when several files report. */
export function DiagnosticsList({ files, showPaths }: { files: readonly FileDiagnostics[]; showPaths?: boolean }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const groups = diagGroups(files);
	const total = groups.reduce((sum, group) => sum + group.items.length, 0);
	if (total === 0) return null;
	const withPath = showPaths === true || groups.length > 1;
	let budget = expanded ? Number.POSITIVE_INFINITY : COLLAPSED_DIAGS;
	const rendered = groups
		.map(group => {
			const take = Math.max(0, Math.min(group.items.length, budget));
			budget -= take;
			return { path: group.path, items: group.items.slice(0, take) };
		})
		.filter(group => group.items.length > 0);
	const shownCount = rendered.reduce((sum, group) => sum + group.items.length, 0);
	const hidden = total - shownCount;
	let row = 0;
	return (
		<div className="space-y-2">
			{rendered.map((group, gi) => (
				<div key={group.path ?? gi}>
					{withPath && group.path && (
						<div className="mb-0.5 font-mono text-omp-sm text-[var(--omp-status-path)]">{group.path}</div>
					)}
					{group.items.map((item, ii) =>
						item.kind === "raw" ? (
							<div
								data-diag-row={row++}
								key={ii}
								className="font-mono text-omp-sm leading-[1.55] break-words whitespace-pre-wrap text-[var(--omp-muted)]"
							>
								{item.text}
							</div>
						) : (
							<div
								className="flex items-baseline gap-1.5 font-mono text-omp-sm leading-[1.55]"
								data-diag-row={row++}
								key={ii}
							>
								<span className="shrink-0 tabular-nums text-[var(--omp-dim)]">
									{item.diag.line}:{item.diag.col}
								</span>
								<span
									className="shrink-0 font-semibold"
									style={{ color: SEVERITY_COLOR[item.diag.severity] ?? "var(--omp-dim)" }}
								>
									{SEVERITY_LABEL_KEYS[item.diag.severity]
										? t(SEVERITY_LABEL_KEYS[item.diag.severity])
										: item.diag.severity}
								</span>
								<span className="min-w-0 break-words text-[var(--omp-text)]">
									{item.diag.text}
									{item.diag.code && <span className="text-[var(--omp-dim)]"> ({item.diag.code})</span>}
									{item.diag.source && <span className="text-[var(--omp-dim)]"> [{item.diag.source}]</span>}
								</span>
							</div>
						),
					)}
				</div>
			))}
			{hidden > 0 && (
				<LinkButton
					onClick={event => {
						const list = event.currentTarget.parentElement;
						revealAndFocus(
							event.currentTarget,
							() => setExpanded(true),
							() => list?.querySelector(`[data-diag-row="${shownCount}"]`),
						);
					}}
					className="text-omp-xs font-medium"
					tone="muted"
				>
					{t("chat.custom.moreDiagnostics", { count: hidden })}
				</LinkButton>
			)}
		</div>
	);
}

/** `2 diagnostics` chip: error tone when any file errored (stock `diagnosticsBadge`). */
export function DiagnosticsChip({ files }: { files: readonly FileDiagnostics[] }) {
	const t = useT();
	const count = diagnosticsCount(files);
	if (count === 0) return null;
	const errored = files.some(file => file.errored);
	return (
		<span
			className={cx(
				"omp-tool-diagnostics shrink-0 text-sc-xs tabular-nums",
				errored ? "text-(--sc-danger)" : "text-(--sc-warning)",
			)}
		>
			{t("tools.diagnostics.count", { count })}
		</span>
	);
}

/** The "Diagnostics" section under an edit/write result (stock `diagnosticsSection`). */
export function DiagnosticsSection({ files }: { files: readonly FileDiagnostics[] }) {
	const t = useT();
	if (diagnosticsCount(files) === 0) return null;
	const errored = files.some(file => file.errored);
	// Stock words the summary for the model; a part it shapes as `N severity(s)` reads in the UI language.
	const summary = files
		.flatMap(file => file.summary?.split(", ") ?? [])
		.map(part => {
			const match = SUMMARY_PART_RE.exec(part);
			const key = match ? SUMMARY_COUNT_KEYS[match[2]] : undefined;
			if (!match || !key) return part;
			const count = Number(match[1]);
			return t(key, { count });
		})
		.join(", ");
	const Icon = errored ? XCircle : AlertTriangle;
	return (
		<section aria-label={t("tools.diagnostics.title")} className="flex flex-col gap-1" data-tool-diagnostics>
			<div className="flex items-center gap-1.5 text-sc-xs">
				<Icon
					aria-hidden
					className={cx("size-3 shrink-0", errored ? "text-(--sc-danger)" : "text-(--sc-warning)")}
				/>
				<span className="font-medium text-(--sc-text-secondary)">{t("tools.diagnostics.title")}</span>
				{summary && <span className="text-(--sc-text-subtle)">{summary}</span>}
			</div>
			<DiagnosticsList files={files} />
		</section>
	);
}
