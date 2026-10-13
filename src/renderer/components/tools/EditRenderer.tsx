import { ArrowRightLeft, Circle, FilePlus2, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { DiffView } from "../../lib/diff";
import { cx, headLines } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import { asNonEmptyString } from "../../lib/wire-value";
import { CodeBlock } from "../chat/CodeBlock";
import { ErrorDetail } from "../common";
import { unifiedDiffStats } from "./diff-stats";
import { editArgumentPaths, editRecordDiff } from "./edit-args";
import { liveDiffPreview } from "./live-diff";
import { PathLink } from "./PathLink";
import { resultBodyText, resultDetails } from "./result";
import { DiffStatChip, ToolPathTarget, type ToolRendererProps } from "./ToolCard";

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

function asOp(value: unknown): EditOp | undefined {
	return value === "create" || value === "delete" || value === "update" ? value : undefined;
}

export function asPerFileResults(value: unknown): EditPerFileResult[] {
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
			move: asNonEmptyString(record.move),
			sourcePath: asNonEmptyString(record.sourcePath),
			isError: record.isError === true,
			errorText: asNonEmptyString(record.errorText),
			displayErrorText: asNonEmptyString(record.displayErrorText),
		});
	}
	return out;
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
	/** Live multi-file block: the card names the operation, so only the file and its stats remain. */
	bare?: boolean;
}

function EditHeader({ op, title, path, moveTo, firstChangedLine, diff, isError, bare }: EditHeaderProps) {
	const t = useT();
	const Icon = op === "delete" ? Trash2 : op === "create" ? FilePlus2 : title != null ? ArrowRightLeft : Pencil;
	const label =
		title ??
		(op === "create"
			? t("tools.edit.op.create")
			: op === "delete"
				? t("tools.edit.op.delete")
				: t("tools.edit.op.edit"));
	const stats = diff ? unifiedDiffStats(diff) : null;
	return (
		<div className="omp-tool-edit-heading flex items-center gap-1.5 font-mono text-omp-sm">
			{bare ? null : (
				<>
					<Icon
						size={12}
						className={cx("shrink-0", isError ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]")}
					/>
					<span
						className={cx(
							"shrink-0 font-semibold",
							isError ? "text-[var(--omp-error)]" : "text-[var(--omp-muted)]",
						)}
					>
						{label}
					</span>
				</>
			)}
			{path && (
				<PathLink path={path} className="truncate">
					<ToolPathTarget path={path} suffix={firstChangedLine ? `:${firstChangedLine}` : undefined} />
				</PathLink>
			)}
			{moveTo && (
				<>
					<span className="shrink-0 text-[var(--omp-dim)]">→</span>
					<PathLink path={moveTo} className="truncate">
						<ToolPathTarget path={moveTo} />
					</PathLink>
				</>
			)}
			{stats && (stats.added > 0 || stats.removed > 0) && <DiffStatChip stats={stats} />}
		</div>
	);
}

/** A file's diff: the newest changed region on the live surface, the whole diff in the transcript. */
function EditDiff({ diff, path, livePreview }: { diff: string; path: string; livePreview?: boolean }) {
	return (
		<DiffView
			diff={livePreview ? liveDiffPreview(diff) : diff}
			filePath={path}
			className={cx("rounded", PREVIEW_SCROLL_LG)}
		/>
	);
}

/** Header (null on the live surface, where the card heading already names the file) above one diff. */
function FileEditPreview({
	header,
	diff,
	path,
	livePreview,
}: {
	header: ReactNode;
	diff: string;
	path: string;
	livePreview?: boolean;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			{header}
			<EditDiff diff={diff} path={path} livePreview={livePreview} />
		</div>
	);
}

/** One file of a multi-file edit result: header + diff, or an inline op row. */
function PerFileEditBlock({ file, livePreview }: { file: EditPerFileResult; livePreview?: boolean }) {
	const t = useT();
	const displayPath = file.sourcePath ?? file.path;

	if (file.isError) {
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={file.op} path={displayPath} moveTo={file.move} isError />
				<div className="rounded bg-[var(--omp-tool-error-bg)] px-2 py-1.5 text-omp-sm text-[var(--omp-error)]">
					{t("tools.edit.failed")}
					<ErrorDetail className="mt-1 whitespace-pre-wrap" error={file.displayErrorText ?? file.errorText} />
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

	// Live, the card names the operation: each file keeps only its name and stats.
	return (
		<FileEditPreview
			header={
				<EditHeader
					op={file.op}
					path={displayPath}
					moveTo={file.move}
					firstChangedLine={file.firstChangedLine}
					diff={file.diff}
					bare={livePreview}
				/>
			}
			diff={file.diff}
			path={displayPath}
			livePreview={livePreview}
		/>
	);
}

/**
 * File edit: op/path/stats header + unified diff from `details.diff` (or
 * `details.perFileResults` for multi-file batches), rendered via DiffView.
 * Delete/move-only ops render as inline rows. Falls back to the args
 * (edits[] pairs, patch diff, apply_patch input, legacy old/new strings)
 * while streaming or for history entries without details.
 */
export function EditRenderer(props: ToolRendererProps) {
	if (!props.livePreview) return <EditContent {...props} />;
	return (
		<div className="omp-tool-editor omp-tool-edit">
			<EditContent {...props} />
		</div>
	);
}

function EditContent({ args, result, isError, isPartial, partialResult, livePreview }: ToolRendererProps) {
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
	const rawPath = asNonEmptyString(details?.sourcePath) ?? argPaths[0] ?? asNonEmptyString(details?.path) ?? "";
	const rename =
		asNonEmptyString(args.rename) ??
		asNonEmptyString(firstEdit?.rename) ??
		asNonEmptyString(firstEdit?.move) ??
		asNonEmptyString(details?.move);
	const detailDiff = typeof details?.diff === "string" ? details.diff : "";
	const firstChangedLine = typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;

	// Multi-file batch: one block per file result, plus a pending indicator
	// for files still being processed.
	if (perFileResults.length > 1 || (perFileResults.length > 0 && totalFiles > 1)) {
		const remaining = Math.max(0, totalFiles - perFileResults.length);
		return (
			<div className="flex flex-col gap-3">
				{perFileResults.map((file, index) => (
					<PerFileEditBlock key={`${index}:${file.path}`} file={file} livePreview={livePreview} />
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
		const rawError = asNonEmptyString(details?.displayErrorText) ?? asNonEmptyString(details?.errorText) ?? bodyText;
		// Hashline-mismatch errors embed source context; a single minified line
		// can be enormous — cap before it enters the DOM.
		const { head: cappedError, omitted } = headLines(rawError, EDIT_ERROR_LINES);
		return (
			<div className="flex flex-col gap-1.5">
				<EditHeader op={op} path={rawPath} moveTo={rename} isError />
				<div className="max-h-72 overflow-y-auto rounded bg-[var(--omp-tool-error-bg)] px-2 py-1.5 text-omp-sm text-[var(--omp-error)]">
					{t("tools.edit.failed")}
					<ErrorDetail className="mt-1 whitespace-pre-wrap" error={cappedError} />
					{omitted > 0 && (
						<div className="mt-1 text-omp-xs opacity-70">
							{t("tools.read.more", { count: omitted, plural: omitted === 1 ? "" : "s" })}
						</div>
					)}
				</div>
			</div>
		);
	}

	// Delete / move-only results: no diff to box — an inline status row, kept on the live surface too.
	if (details && !detailDiff && (op === "delete" || rename)) {
		return (
			<EditHeader
				op={op}
				title={op === "delete" ? undefined : t("tools.edit.op.move")}
				path={rawPath}
				moveTo={rename}
			/>
		);
	}

	// apply_patch mode: the raw input is a patch document, not a unified diff.
	const patchInput = asNonEmptyString(args.input) ?? asNonEmptyString(args._input);
	// One diff for the whole call: the authoritative result, else (streaming or
	// legacy history) the args' patch, else a top-level legacy old/new pair.
	const singleDiff = details
		? detailDiff
		: (asNonEmptyString(args.diff) ??
			asNonEmptyString(args.previewDiff) ??
			(argEdits.length === 0 && !patchInput ? editRecordDiff(args) : undefined));
	if (singleDiff) {
		return (
			<FileEditPreview
				header={
					livePreview ? null : (
						<EditHeader
							op={op}
							path={rawPath}
							moveTo={rename}
							firstChangedLine={firstChangedLine}
							diff={singleDiff}
						/>
					)
				}
				diff={singleDiff}
				path={rawPath}
				livePreview={livePreview}
			/>
		);
	}

	if (details) {
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

	if (argEdits.length > 0) {
		// Hashline-style batches span files: no single header path, every
		// entry gets its own path label. A single entry's diff also feeds the
		// header stats.
		const multiFileArgs = totalFiles > 1;
		return (
			<div className="flex flex-col gap-1.5">
				{livePreview ? null : (
					<EditHeader
						op={op}
						path={multiFileArgs ? "" : rawPath}
						moveTo={rename}
						diff={argEdits.length === 1 ? editRecordDiff(argEdits[0]) : undefined}
					/>
				)}
				{argEdits.map((entry, index) => {
					const entryPath = asNonEmptyString(entry.path);
					const entryDiff = editRecordDiff(entry);
					const entryOp = asOp(entry.op);
					const entryRename = asNonEmptyString(entry.rename) ?? asNonEmptyString(entry.move);
					const key = `${index}:${entryPath ?? ""}`;
					if (entryDiff) {
						return (
							<div key={key} className="flex flex-col gap-1">
								{entryPath !== undefined && (multiFileArgs || entryPath !== rawPath) && (
									<div className="truncate font-mono text-omp-xs text-[var(--omp-dim)]">{entryPath}</div>
								)}
								<EditDiff diff={entryDiff} path={entryPath ?? rawPath} livePreview={livePreview} />
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
