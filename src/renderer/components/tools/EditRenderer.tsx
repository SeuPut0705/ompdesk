import { ArrowRightLeft, Circle, FilePlus2, Pencil, Trash2 } from "lucide-react";
import { DiffView } from "../../lib/diff";
import { basename, cx, dirname, headLines } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import { CodeBlock } from "../chat/CodeBlock";
import { editArgumentPaths } from "./edit-args";
import { PathLink } from "./PathLink";
import { resultBodyText, resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

type EditOp = "create" | "delete" | "update";

/** Ceiling for error bodies (hashline mismatches embed source context). */
const EDIT_ERROR_LINES = 100;

/** Per-file entry of `details.perFileResults` (multi-file edit results). */
interface EditPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	op?: EditOp;
	move?: string;
	sourcePath?: string;
	isError?: boolean;
	errorText?: string;
	displayErrorText?: string;
}

/** Non-empty string or undefined — the wire shape's optional string fields. */
function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOp(value: unknown): EditOp | undefined {
	return value === "create" || value === "delete" || value === "update" ? value : undefined;
}

function asPerFileResults(value: unknown): EditPerFileResult[] {
	if (!Array.isArray(value)) return [];
	const out: EditPerFileResult[] = [];
	for (const entry of value) {
		if (entry == null || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.path !== "string") continue;
		out.push({
			path: record.path,
			diff: typeof record.diff === "string" ? record.diff : "",
			firstChangedLine: typeof record.firstChangedLine === "number" ? record.firstChangedLine : undefined,
			op: asOp(record.op),
			move: asString(record.move),
			sourcePath: asString(record.sourcePath),
			isError: record.isError === true,
			errorText: asString(record.errorText),
			displayErrorText: asString(record.displayErrorText),
		});
	}
	return out;
}

/** Added/removed line counts of a unified diff (file headers excluded). */
function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Synthesize a unified-diff-shaped block from an old/new text pair (args fallback). */
function oldNewDiff(oldStr: string | null | undefined, newStr: string | null | undefined): string {
	const lines: string[] = [];
	if (oldStr != null) for (const line of oldStr.split("\n")) lines.push(`-${line}`);
	if (newStr != null) for (const line of newStr.split("\n")) lines.push(`+${line}`);
	return lines.join("\n");
}

interface EditHeaderProps {
	op?: EditOp;
	/** Title override — set by move-only rows, which also take the move icon. */
	title?: string;
	path: string;
	/** Destination of a move/rename — rendered as `path → moveTo`. */
	moveTo?: string;
	firstChangedLine?: number;
	/** Diff whose +added/-removed stats ride the header; omitted when absent. */
	diff?: string;
	isError?: boolean;
}

function EditHeader({ op, title, path, moveTo, firstChangedLine, diff, isError }: EditHeaderProps) {
	const t = useT();
	const Icon = op === "delete" ? Trash2 : op === "create" ? FilePlus2 : title != null ? ArrowRightLeft : Pencil;
	const label =
		title ??
		(op === "create"
			? t("tools.edit.op.create")
			: op === "delete"
				? t("tools.edit.op.delete")
				: t("tools.edit.op.edit"));
	const stats = diff ? diffStats(diff) : null;
	return (
		<div className="flex items-center gap-1.5 font-mono text-omp-sm">
			<Icon size={12} className={cx("shrink-0", isError ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]")} />
			<span
				className={cx("shrink-0 font-semibold", isError ? "text-[var(--omp-error)]" : "text-[var(--omp-muted)]")}
			>
				{label}
			</span>
			{path && (
				<>
					<PathLink path={path} className="truncate text-[var(--omp-text)]">
						{basename(path)}
						{firstChangedLine ? `:${firstChangedLine}` : ""}
					</PathLink>
					<span className="truncate text-[var(--omp-dim)]">{dirname(path)}</span>
				</>
			)}
			{moveTo && (
				<>
					<span className="shrink-0 text-[var(--omp-dim)]">→</span>
					<PathLink path={moveTo} className="truncate text-[var(--omp-text)]">
						{basename(moveTo)}
					</PathLink>
					<span className="truncate text-[var(--omp-dim)]">{dirname(moveTo)}</span>
				</>
			)}
			{stats && (stats.added > 0 || stats.removed > 0) && (
				<span className="shrink-0 text-omp-xxs tabular-nums">
					<span className="text-[var(--omp-dim)]">[</span>
					{stats.added > 0 && <span className="text-[var(--omp-diff-added)]">+{stats.added}</span>}
					{stats.added > 0 && stats.removed > 0 && <span className="text-[var(--omp-dim)]">/</span>}
					{stats.removed > 0 && <span className="text-[var(--omp-diff-removed)]">-{stats.removed}</span>}
					<span className="text-[var(--omp-dim)]">]</span>
				</span>
			)}
		</div>
	);
}

/** One file of a multi-file edit result: header + diff, or an inline op row. */
function PerFileEditBlock({ file }: { file: EditPerFileResult }) {
	const t = useT();
	const displayPath = file.sourcePath ?? file.path;

	if (file.isError) {
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={file.op} path={displayPath} moveTo={file.move} isError />
				<div className="whitespace-pre-wrap rounded bg-[var(--omp-tool-error-bg)] px-2 py-1.5 text-omp-sm text-[var(--omp-error)]">
					{file.displayErrorText ?? file.errorText ?? t("tools.edit.failed")}
				</div>
			</div>
		);
	}

	// Delete and move-only results carry no diff — inline status rows.
	if (!file.diff) {
		if (file.op === "delete") {
			return <EditHeader op="delete" path={displayPath} moveTo={file.move} />;
		}
		if (file.move || file.sourcePath) {
			return <EditHeader title={t("tools.edit.op.move")} path={displayPath} moveTo={file.move ?? file.path} />;
		}
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={file.op} path={displayPath} />
				{file.op !== "create" && (
					<div className="text-omp-sm italic text-[var(--omp-dim)]">
						{t("tools.edit.noChangesTo", { path: file.path })}
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<EditHeader
				op={file.op}
				path={displayPath}
				moveTo={file.move}
				firstChangedLine={file.firstChangedLine}
				diff={file.diff}
			/>
			<DiffView diff={file.diff} filePath={displayPath} className={cx("rounded", PREVIEW_SCROLL_LG)} />
		</div>
	);
}

/**
 * File edit: op/path/stats header + unified diff from `details.diff` (or
 * `details.perFileResults` for multi-file batches), rendered via DiffView.
 * Delete/move-only ops render as inline rows. Falls back to the args
 * (edits[] pairs, patch diff, apply_patch input, legacy old/new strings)
 * while streaming or for history entries without details.
 */
export function EditRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const details = resultDetails(result) ?? resultDetails(partialResult);
	const perFileResults = asPerFileResults(details?.perFileResults);

	// Args drive the header and the no-details fallback (streaming previews,
	// legacy history). Replace mode: edits[] of old_text/new_text; patch mode:
	// edits[] of op/rename/diff; hashline: edits[] with per-entry paths.
	const argEdits = Array.isArray(args.edits)
		? args.edits.filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === "object")
		: [];
	const firstEdit = argEdits[0];
	const argPaths = editArgumentPaths(args);
	const totalFiles = argPaths.length;

	const op = asOp(args.op) ?? asOp(firstEdit?.op) ?? asOp(details?.op);
	const rawPath = asString(details?.sourcePath) ?? argPaths[0] ?? asString(details?.path) ?? "";
	const rename =
		asString(args.rename) ?? asString(firstEdit?.rename) ?? asString(firstEdit?.move) ?? asString(details?.move);
	const detailDiff = typeof details?.diff === "string" ? details.diff : "";
	const firstChangedLine = typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;

	// Multi-file batch: one block per file result, plus a pending indicator
	// for files still being processed.
	if (perFileResults.length > 1 || (perFileResults.length > 0 && totalFiles > 1)) {
		const remaining = Math.max(0, totalFiles - perFileResults.length);
		return (
			<div className="flex flex-col gap-3">
				{perFileResults.map((file, index) => (
					<PerFileEditBlock key={`${index}:${file.path}`} file={file} />
				))}
				{remaining > 0 && isPartial && (
					<div className="flex items-center gap-1.5 text-omp-sm text-[var(--omp-dim)]">
						<Circle aria-hidden size={7} className="fill-current text-[var(--omp-accent)]" />
						{t("tools.edit.morePending", { count: remaining, plural: remaining === 1 ? "" : "s" })}
					</div>
				)}
			</div>
		);
	}

	if (isError) {
		const bodyText = (resultBodyText(result) || resultBodyText(partialResult)).trim();
		const rawError = asString(details?.displayErrorText) ?? asString(details?.errorText) ?? bodyText;
		// Hashline-mismatch errors embed source context; a single minified line
		// can be enormous — cap before it enters the DOM.
		const { head: cappedError, omitted } = headLines(rawError || t("tools.edit.failed"), EDIT_ERROR_LINES);
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={op} path={rawPath} moveTo={rename} isError />
				<div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded bg-[var(--omp-tool-error-bg)] px-2 py-1.5 text-omp-sm text-[var(--omp-error)]">
					{cappedError}
					{omitted > 0 && (
						<div className="mt-1 text-omp-xs opacity-70">
							{t("tools.read.more", { count: omitted, plural: omitted === 1 ? "" : "s" })}
						</div>
					)}
				</div>
			</div>
		);
	}

	// Authoritative single-file result.
	if (details) {
		// Delete / move-only: no diff to box — an inline status row.
		if (!detailDiff && (op === "delete" || rename)) {
			return (
				<EditHeader
					op={op}
					title={op === "delete" ? undefined : t("tools.edit.op.move")}
					path={rawPath}
					moveTo={rename}
				/>
			);
		}
		if (detailDiff) {
			return (
				<div className="flex flex-col gap-1.5">
					<EditHeader
						op={op}
						path={rawPath}
						moveTo={rename}
						firstChangedLine={firstChangedLine}
						diff={detailDiff}
					/>
					<DiffView diff={detailDiff} filePath={rawPath} className={cx("rounded", PREVIEW_SCROLL_LG)} />
				</div>
			);
		}
		// No textual diff: a create (header says it all) or a genuine no-op.
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={op} path={rawPath} moveTo={rename} />
				{op !== "create" && (
					<div className="text-omp-sm italic text-[var(--omp-dim)]">
						{rawPath ? t("tools.edit.noChangesTo", { path: rawPath }) : t("tools.edit.noChanges")}
					</div>
				)}
			</div>
		);
	}

	// ── No details yet (streaming) or legacy history: reconstruct from args. ──
	const argDiff = asString(args.diff) ?? asString(args.previewDiff);
	if (argDiff) {
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={op} path={rawPath} moveTo={rename} diff={argDiff} />
				<DiffView diff={argDiff} filePath={rawPath} className={cx("rounded", PREVIEW_SCROLL_LG)} />
			</div>
		);
	}

	if (argEdits.length > 0) {
		// Hashline-style batches span files: no single header path, every
		// entry gets its own path label. A single entry's diff also feeds the
		// header stats.
		const multiFileArgs = totalFiles > 1;
		const single = argEdits.length === 1 ? argEdits[0] : undefined;
		const singleOld = single
			? (asString(single.old_text) ?? asString(single.old_string) ?? asString(single.oldText))
			: undefined;
		const singleNew = single
			? (asString(single.new_text) ?? asString(single.new_string) ?? asString(single.newText))
			: undefined;
		const singleDiff = single
			? (asString(single.diff) ??
				(singleOld != null || singleNew != null ? oldNewDiff(singleOld, singleNew) : undefined))
			: undefined;
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={op} path={multiFileArgs ? "" : rawPath} moveTo={rename} diff={singleDiff} />
				{argEdits.map((entry, index) => {
					const entryPath = asString(entry.path);
					const entryDiff = asString(entry.diff);
					const entryOld = asString(entry.old_text) ?? asString(entry.old_string) ?? asString(entry.oldText);
					const entryNew = asString(entry.new_text) ?? asString(entry.new_string) ?? asString(entry.newText);
					const entryOp = asOp(entry.op);
					const entryRename = asString(entry.rename) ?? asString(entry.move);
					const key = `${index}:${entryPath ?? ""}`;
					const showPathLabel = entryPath !== undefined && (multiFileArgs || entryPath !== rawPath);
					if (entryDiff) {
						return (
							<div key={key} className="flex flex-col gap-1">
								{showPathLabel && (
									<div className="truncate font-mono text-omp-xs text-[var(--omp-dim)]">{entryPath}</div>
								)}
								<DiffView
									diff={entryDiff}
									filePath={entryPath ?? rawPath}
									className={cx("rounded", PREVIEW_SCROLL_LG)}
								/>
							</div>
						);
					}
					if (entryOld != null || entryNew != null) {
						return (
							<div key={key} className="flex flex-col gap-1">
								{showPathLabel && (
									<div className="truncate font-mono text-omp-xs text-[var(--omp-dim)]">{entryPath}</div>
								)}
								<DiffView
									diff={oldNewDiff(entryOld, entryNew)}
									filePath={entryPath ?? rawPath}
									className={cx("rounded", PREVIEW_SCROLL_LG)}
								/>
							</div>
						);
					}
					if (entryOp === "delete" || entryRename) {
						return (
							<EditHeader
								key={key}
								op={entryOp}
								title={entryOp === "delete" ? undefined : t("tools.edit.op.move")}
								path={entryPath ?? rawPath}
								moveTo={entryRename}
							/>
						);
					}
					return null;
				})}
			</div>
		);
	}

	// apply_patch mode: the raw input is a patch document, not a unified diff.
	const patchInput = asString(args.input) ?? asString(args._input);
	if (patchInput) {
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={op} path={rawPath} moveTo={rename} />
				<CodeBlock
					code={patchInput}
					language="diff"
					showLanguage={false}
					showCopy={false}
					maxHeightClass="max-h-72"
				/>
			</div>
		);
	}

	// Single old/new pair (legacy replace args).
	const oldStr = asString(args.old_string) ?? asString(args.old_text) ?? asString(args.oldText);
	const newStr = asString(args.new_string) ?? asString(args.new_text) ?? asString(args.newText);
	if (oldStr != null || newStr != null) {
		const fallbackDiff = oldNewDiff(oldStr, newStr);
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={op} path={rawPath} moveTo={rename} diff={fallbackDiff} />
				<DiffView diff={fallbackDiff} filePath={rawPath} className={cx("rounded", PREVIEW_SCROLL_LG)} />
			</div>
		);
	}

	if (isPartial) {
		return (
			<div className="flex items-center gap-1.5 text-omp-sm text-[var(--omp-dim)]">
				<Circle aria-hidden size={7} className="fill-current text-[var(--omp-accent)]" />
				{t("tools.edit.applying")}
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			<EditHeader op={op} path={rawPath} moveTo={rename} />
			<div className="text-omp-sm italic text-[var(--omp-dim)]">{t("tools.edit.applied")}</div>
		</div>
	);
}
