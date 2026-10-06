import { FileCode2 } from "lucide-react";
import type { ReactNode } from "react";
import { cx, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ToolRendererProps } from "./ToolCard";

/**
 * ast_edit: staged AST rewrite preview. Reads the structured details envelope
 * (AstEditToolDetails): replacement/file counts, searched count, scope, limit
 * flag, parse errors, and the pre-formatted `displayContent` change tree.
 * The change tree is rendered as per-file groups of styled +/- lines, mirroring
 * the TUI renderer (packages/coding-agent/src/tools/ast-edit.ts). A `proposed`
 * badge marks the staged (not-yet-applied) state; xd://resolve applies it.
 */

type ChangeRow =
	| { type: "header"; text: string; depth: number }
	| { type: "add" | "remove"; lineNo: string; content: string }
	| { type: "context"; content: string };

interface ChangeGroup {
	rows: ChangeRow[];
}

const HEADER_RE = /^(#+)\s+(.*)$/;
/** displayContent lines: `-315│code` / `+315│code` (formatCodeFrameLine). */
const DISPLAY_LINE_RE = /^\s*([+-])(\d+)│(.*)$/;
/** Model-text fallback lines: `-315:code` (hash mode) or `-315:10 code`. */
const MODEL_LINE_RE = /^([+-])(\d+)(?::\d+)?[: ](.*)$/;
/** Non-change groups the tool appends to the plain-text result; the renderer
 * surfaces them from structured details instead (mirrors the TUI filters). */
const SKIP_GROUP_PREFIXES = ["Staged as a proposal", "Limit reached", "Safety cap reached", "Parse issues"];

/** Split the result text into blank-line-separated groups, then parse each
 * group into header / + / - / context rows. */
function parseChangeGroups(text: string): ChangeGroup[] {
	if (!text.trim()) return [];
	const rawGroups: string[][] = [];
	let current: string[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			if (current.length > 0) {
				rawGroups.push(current);
				current = [];
			}
			continue;
		}
		current.push(line);
	}
	if (current.length > 0) rawGroups.push(current);

	const groups: ChangeGroup[] = [];
	for (const raw of rawGroups) {
		const first = raw[0]!;
		if (SKIP_GROUP_PREFIXES.some(prefix => first.startsWith(prefix))) continue;
		const rows: ChangeRow[] = [];
		for (const line of raw) {
			const header = HEADER_RE.exec(line);
			if (header) {
				rows.push({ type: "header", text: header[2]!.trimEnd(), depth: header[1]!.length });
				continue;
			}
			const display = DISPLAY_LINE_RE.exec(line);
			if (display) {
				rows.push({ type: display[1] === "+" ? "add" : "remove", lineNo: display[2]!, content: display[3]! });
				continue;
			}
			const model = MODEL_LINE_RE.exec(line);
			if (model) {
				rows.push({ type: model[1] === "+" ? "add" : "remove", lineNo: model[2]!, content: model[3]! });
				continue;
			}
			rows.push({ type: "context", content: line });
		}
		groups.push({ rows });
	}
	return groups;
}

function Chip({ children, title, warning }: { children: ReactNode; title?: string; warning?: boolean }) {
	return (
		<span
			title={title}
			className={cx(
				"max-w-64 shrink-0 truncate rounded px-1 py-px font-mono text-omp-xxs tabular-nums",
				warning
					? "bg-[var(--omp-warning)]/15 text-[var(--omp-warning)]"
					: "bg-[var(--omp-bg-tertiary)] text-[var(--omp-muted)]", // surface-ok: tiny count/info pill
			)}
		>
			{children}
		</span>
	);
}

export function AstEditRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();

	// Args: { ops: [{ pat, out }], paths: [] } — description metadata only; the
	// change set itself arrives via the result envelope.
	const ops = Array.isArray(args.ops) ? (args.ops as Array<{ pat?: unknown }>) : [];
	const fullPattern = ops.length === 1 && typeof ops[0]?.pat === "string" ? ops[0].pat : "";
	// Status-line preview: collapse whitespace runs so a multi-line pattern stays one line.
	const pattern = fullPattern.replace(/\s+/g, " ").trim();
	const argPaths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];

	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	const text = resultText(effective);

	const totalReplacements = typeof details?.totalReplacements === "number" ? details.totalReplacements : 0;
	const filesTouched = typeof details?.filesTouched === "number" ? details.filesTouched : 0;
	const filesSearched = typeof details?.filesSearched === "number" ? details.filesSearched : 0;
	const limitReached = details?.limitReached === true;
	const staged = details?.applied === false;
	const scope = typeof details?.scopePath === "string" && details.scopePath ? details.scopePath : argPaths.join(", ");
	const parseErrors = Array.isArray(details?.parseErrors)
		? details.parseErrors.filter((e): e is string => typeof e === "string")
		: [];
	const parseErrorsTotal =
		typeof details?.parseErrorsTotal === "number" ? details.parseErrorsTotal : parseErrors.length;
	const displayContent = typeof details?.displayContent === "string" ? details.displayContent : "";

	const hasDetails = details != null;
	const zeroResult = hasDetails && totalReplacements === 0;
	// displayContent carries the user-facing tree; fall back to the plain text
	// (model format) when it is absent. Zero-replacement results have no change
	// tree — their text is just "No replacements made" + parse issues — and error
	// results render their message in the error block below, not as pseudo-changes.
	const groups = isError || zeroResult ? [] : parseChangeGroups(displayContent || text);

	const parseLabel =
		parseErrorsTotal > parseErrors.length
			? t("tools.astedit.parseIssuesCapped", { shown: parseErrors.length, total: parseErrorsTotal })
			: t("tools.astedit.parseIssues", { count: parseErrors.length, plural: parseErrors.length === 1 ? "" : "s" });

	return (
		<div className="flex flex-col gap-1.5">
			{/* Header: pattern preview + rewrite/proposed badges */}
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<FileCode2 size={12} className="shrink-0 text-[var(--omp-md-code)]" />
				<span className="min-w-0 flex-1 truncate text-[var(--omp-text)]" title={fullPattern || undefined}>
					{pattern || t("tools.astedit.fallback")}
				</span>
				{ops.length > 1 && <Chip>{t("tools.astedit.rewrites", { count: ops.length })}</Chip>}
				{staged && !isPartial && !isError && totalReplacements > 0 && (
					<Chip warning>{t("tools.astedit.proposed")}</Chip>
				)}
			</div>

			{/* Meta chips: counts, scope, searched, limit (TUI status-line meta) */}
			{hasDetails && !isPartial && !isError && (
				<div className="flex flex-wrap items-center gap-1">
					<Chip>
						{t("tools.astedit.replacements", {
							count: totalReplacements,
							plural: totalReplacements === 1 ? "" : "s",
						})}
					</Chip>
					{totalReplacements > 0 && (
						<Chip>
							{t("tools.astedit.files", { count: filesTouched, plural: filesTouched === 1 ? "" : "s" })}
						</Chip>
					)}
					{scope && <Chip title={scope}>{t("tools.astedit.scope", { path: scope })}</Chip>}
					{filesSearched > 0 && <Chip>{t("tools.astedit.searched", { count: filesSearched })}</Chip>}
					{limitReached && <Chip warning>{t("tools.astedit.limitChip")}</Chip>}
				</div>
			)}

			{/* Per-file change groups: styled old (-) → new (+) lines */}
			{groups.length > 0 && (
				<div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
					{groups.map((group, gi) => (
						<div key={gi} className="rounded bg-[var(--omp-code-bg)] py-1 font-mono text-omp-sm leading-[1.45]">
							{group.rows.map((row, ri) => {
								if (row.type === "header") {
									return (
										<div
											key={ri}
											className={cx(
												"truncate px-2",
												row.text.endsWith("/") || row.depth === 1
													? "text-[var(--omp-accent)]"
													: "text-[var(--omp-dim)]",
											)}
										>
											{row.text}
										</div>
									);
								}
								if (row.type === "context") {
									return (
										<div key={ri} className="whitespace-pre-wrap px-2 text-[var(--omp-tool-output)]">
											{row.content}
										</div>
									);
								}
								const added = row.type === "add";
								return (
									<div
										key={ri}
										className={cx(
											"flex gap-2 px-2",
											added
												? "bg-[var(--omp-diff-added)]/10 text-[var(--omp-diff-added)]"
												: "bg-[var(--omp-diff-removed)]/10 text-[var(--omp-diff-removed)]",
										)}
									>
										<span className="w-8 shrink-0 select-none text-right tabular-nums opacity-60">
											{row.lineNo}
										</span>
										<span className="shrink-0 select-none opacity-60">{added ? "+" : "-"}</span>
										<span className="min-w-0 flex-1 whitespace-pre-wrap">{row.content}</span>
									</div>
								);
							})}
						</div>
					))}
				</div>
			)}

			{/* Limit-reached note (TUI body line) */}
			{limitReached && !isPartial && !isError && (
				<div className="text-omp-sm text-[var(--omp-warning)]">{t("tools.astedit.limitReached")}</div>
			)}

			{/* Parse issues: count label + capped bullet list + overflow note */}
			{parseErrors.length > 0 && !isPartial && !isError && (
				<div className="rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45]">
					<div className="text-[var(--omp-warning)]">{parseLabel}</div>
					{parseErrors.map((err, i) => (
						<div key={i} className="whitespace-pre-wrap text-[var(--omp-warning)]">
							- {err}
						</div>
					))}
					{parseErrorsTotal > parseErrors.length && (
						<div className="text-[var(--omp-dim)]">
							{t("tools.astedit.parseMore", { count: parseErrorsTotal - parseErrors.length })}
						</div>
					)}
				</div>
			)}

			{/* States */}
			{isPartial && <div className="text-omp-sm italic text-[var(--omp-dim)]">{t("tools.astedit.editing")}</div>}
			{isError && (
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-tool-error-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-error)]">
					{text || t("tools.astedit.failed")}
				</pre>
			)}
			{!isPartial && !isError && zeroResult && parseErrors.length === 0 && (
				<div className="text-omp-sm italic text-[var(--omp-dim)]">{t("tools.astedit.noReplacements")}</div>
			)}
		</div>
	);
}
