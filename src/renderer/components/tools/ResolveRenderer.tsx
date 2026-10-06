import { Ban, Check, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { resultBodyText, resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

/**
 * xd://resolve + xd://reject (resolution device): outcome of applying or
 * discarding a staged proposal. Live results carry ResolveDetails
 * ({ action, reason, sourceToolName?, label?, sourceResultDetails? });
 * hydrated history falls back to the content text.
 */

/** Affected-op count hidden in a source tool's details (ast_edit ops, …). */
function affectedOpCount(sourceResultDetails: unknown): number | undefined {
	if (sourceResultDetails == null || typeof sourceResultDetails !== "object") return undefined;
	const record = sourceResultDetails as Record<string, unknown>;
	for (const key of ["ops", "operations", "edits", "changes"]) {
		const value = record[key];
		if (Array.isArray(value)) return value.length;
	}
	for (const key of ["opsCount", "opCount", "appliedOps"]) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

const MAX_LISTED_FILES = 6;

/** File list hidden in a source tool's details, as displayable paths. */
function affectedFiles(sourceResultDetails: unknown): string[] {
	if (sourceResultDetails == null || typeof sourceResultDetails !== "object") return [];
	const record = sourceResultDetails as Record<string, unknown>;
	for (const key of ["files", "paths", "affectedFiles", "modifiedFiles"]) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		const paths = value
			.map(entry => {
				if (typeof entry === "string") return entry;
				if (entry != null && typeof entry === "object") {
					const e = entry as Record<string, unknown>;
					return typeof e.path === "string" ? e.path : typeof e.file === "string" ? e.file : "";
				}
				return "";
			})
			.filter(path => path.length > 0);
		if (paths.length > 0) return paths;
	}
	return [];
}

export function ResolveRenderer({
	args,
	result,
	isError,
	isPartial,
	partialResult,
	operation,
}: ToolRendererProps & { operation?: "resolve" | "reject" }) {
	const t = useT();
	const details = resultDetails(isPartial ? partialResult : result);
	// Registry wrappers pass the real operation: a pending reject carries only
	// a reason (no details yet) and previously rendered as "Resolving".
	const action =
		details?.action === "discard" || args.action === "discard"
			? "discard"
			: operation === "reject"
				? "discard"
				: "apply";
	const reason =
		(typeof details?.reason === "string" && details.reason.trim()) ||
		(typeof args.reason === "string" && args.reason.trim()) ||
		"";
	const label = typeof details?.label === "string" ? details.label : "";
	const sourceToolName = typeof details?.sourceToolName === "string" ? details.sourceToolName : "";
	const separatorIndex = label.indexOf(": ");
	const source = sourceToolName || (separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : "");
	const summary = separatorIndex > 0 ? label.slice(separatorIndex + 2).trim() : label;
	const ops = affectedOpCount(details?.sourceResultDetails);
	const files = affectedFiles(details?.sourceResultDetails);

	const pending = isPartial;
	const verb = pending
		? action === "apply"
			? t("tools.resolve.resolving")
			: t("tools.resolve.rejecting")
		: isError
			? // A failed reject/discard must not claim the action was discarded.
				t("tools.resolve.failed")
			: action === "apply"
				? t("tools.resolve.applied")
				: t("tools.resolve.discarded");
	const tone = pending ? "accent" : isError ? "error" : action === "apply" ? "success" : "warning";
	const Icon = pending ? Check : isError ? X : action === "apply" ? Check : Ban;
	const fallback = details == null ? resultBodyText(result).trim() : "";

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 text-omp-sm">
				<Icon size={12} className="shrink-0" style={{ color: `var(--omp-${tone})` }} />
				<span className="font-semibold" style={{ color: `var(--omp-${tone})` }}>
					{verb}
				</span>
				{summary && <span className="min-w-0 flex-1 truncate text-[var(--omp-text)]">{summary}</span>}
				{!summary && <span className="flex-1" />}
				{source && (
					<span
						className="shrink-0 rounded bg-[var(--omp-bg-tertiary)] px-1 py-px font-mono text-omp-xxs text-[var(--omp-muted)]" // surface-ok: tiny source pill
					>
						{source}
					</span>
				)}
				{ops != null && (
					<span
						className="shrink-0 rounded bg-[var(--omp-bg-tertiary)] px-1 py-px font-mono text-omp-xxs tabular-nums text-[var(--omp-muted)]" // surface-ok: tiny ops count pill
					>
						{t("tools.resolve.ops", { count: ops, plural: ops === 1 ? "" : "s" })}
					</span>
				)}
			</div>
			{reason && <div className="text-omp-sm italic leading-[1.45] text-[var(--omp-muted)]">{reason}</div>}
			{files.length > 0 && (
				<div className="rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.5] text-[var(--omp-tool-output)]">
					{files.slice(0, MAX_LISTED_FILES).map(file => (
						<div key={file} className="truncate">
							{file}
						</div>
					))}
					{files.length > MAX_LISTED_FILES && (
						<div className="text-[var(--omp-dim)]">
							{t("tools.resolve.more", { count: files.length - MAX_LISTED_FILES })}
						</div>
					)}
				</div>
			)}
			{!reason && fallback && (
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-tool-output)]">
					{fallback}
				</pre>
			)}
		</div>
	);
}
