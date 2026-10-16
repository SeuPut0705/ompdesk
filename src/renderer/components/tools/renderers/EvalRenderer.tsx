import { CircleX, Code2 } from "lucide-react";
import { extractImageDataUrls, formatDuration, resultDetails, resultText } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { asArray, asNumber, asRecord, asString } from "../../../lib/wire-value";
import { CodeBlock } from "../../chat/CodeBlock";
import { Spinner } from "../../common";
import { ResultImages } from "../media/ResultImages";
import type { ToolRendererProps } from "../ToolCard";
import { stripBackgroundNotice } from "./BashRenderer";
import { JsonTree } from "./JsonTree";
import { metaTruncation, TruncationNote } from "./output-meta";
import { ToolTextPreview } from "./ToolTextPreview";

/** Stock eval's language tokens as the highlighter names them. */
function highlightLanguage(language: string | undefined): string {
	if (language === "py" || language === "python") return "python";
	return "javascript";
}

/** One cell as the card shows it: `EvalCellResult` once it ran, the call's cell argument before. */
interface CellView {
	title?: string;
	code: string;
	language: string;
	output?: string;
	status?: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	exitCode?: number;
}

const CELL_STATUSES: Record<string, CellView["status"]> = {
	pending: "pending",
	running: "running",
	complete: "complete",
	error: "error",
};

/**
 * Cells of an eval call (stock pi-tui `tools/eval.ts`, `EvalToolDetails.cells`):
 * the result's per-cell code, status, time and output, else the call's
 * `cells[]` (or its single `code`) while the cells still stream.
 */
function evalCells(args: Record<string, unknown>, details: Record<string, unknown> | undefined): CellView[] {
	const ran = asArray(details?.cells).flatMap(entry => {
		const cell = asRecord(entry);
		const code = asString(cell?.code);
		if (!cell || code === undefined) return [];
		return [
			{
				title: asString(cell.title),
				code,
				language: highlightLanguage(asString(cell.language)),
				output: asString(cell.output),
				status: CELL_STATUSES[asString(cell.status) ?? ""],
				durationMs: asNumber(cell.durationMs),
				exitCode: asNumber(cell.exitCode),
			},
		];
	});
	if (ran.length > 0) return ran;
	const requested = asArray(args.cells).flatMap(entry => {
		const cell = asRecord(entry);
		const code = asString(cell?.code);
		return cell && code !== undefined
			? [{ title: asString(cell.title), code, language: highlightLanguage(asString(cell.language)) }]
			: [];
	});
	if (requested.length > 0) return requested;
	const code = asString(args.code);
	return code === undefined
		? []
		: [{ title: asString(args.title), code, language: highlightLanguage(asString(args.language)) }];
}

function CellStatus({ cell }: { cell: CellView }) {
	const t = useT();
	return (
		<span className="ml-auto flex shrink-0 items-center gap-1.5 text-sc-xs tabular-nums text-(--sc-text-subtle)">
			{cell.status === "running" && <Spinner size="sm" />}
			{cell.status === "error" && (
				<CircleX aria-label={t("tools.eval.error")} className="size-3 text-(--sc-danger)" role="img" />
			)}
			{cell.exitCode !== undefined && cell.exitCode !== 0 && (
				<span className="text-(--sc-danger)">{t("tools.coordination.exit", { code: cell.exitCode })}</span>
			)}
			{cell.durationMs !== undefined && <span>{formatDuration(cell.durationMs)}</span>}
		</span>
	);
}

/**
 * Eval: code cells with language badge + output below. Several cells each get
 * their title, status, time and output (stock eval cell rows); `display()`
 * values (`details.jsonOutputs`) render as JSON trees, and stock's `notice`
 * (e.g. a fallback explanation) and output truncation as quiet notes.
 */
export function EvalRenderer({ args, result, isError, isPartial, partialResult, livePreview }: ToolRendererProps) {
	const t = useT();
	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	// A cell stock moved to the background ends with the same notice as a command (eval.ts):
	// restate it as the job note instead of printing the model-facing instructions.
	const job = asRecord(details?.async);
	const backgrounded = job?.state === "running" && typeof job.jobId === "string" ? job.jobId : null;
	const text = resultText(effective);
	const output = backgrounded ? stripBackgroundNotice(text, backgrounded) : text;
	const images = extractImageDataUrls(effective);
	const cells = evalCells(args, details);
	const jsonOutputs = livePreview ? [] : asArray(details?.jsonOutputs);
	const notice = asString(details?.notice);
	const truncation = metaTruncation(details);
	const multi = cells.length > 1;

	return (
		<div className={livePreview ? "omp-tool-editor omp-tool-eval flex flex-col gap-1.5" : "flex flex-col gap-1.5"}>
			{multi && !livePreview && (
				<div className="text-sc-xs text-(--sc-text-subtle)">{t("tools.eval.cells", { count: cells.length })}</div>
			)}
			{cells.map((cell, index) => (
				<div key={index} className="flex flex-col gap-1" data-eval-cell>
					{!livePreview && (cell.title || multi) && (
						<div className="flex items-center gap-1.5 text-omp-sm">
							<Code2 size={12} className="shrink-0 text-[var(--omp-dim)]" />
							<span className="min-w-0 truncate font-medium text-[var(--omp-text)]">
								{cell.title || t("tools.eval.cell", { index: index + 1 })}
							</span>
							{multi && <CellStatus cell={cell} />}
						</div>
					)}
					{cell.code && (
						<CodeBlock
							code={cell.code}
							language={cell.language}
							showLanguage={!livePreview}
							showCopy={false}
							maxHeightClass="max-h-64"
						/>
					)}
					{multi && cell.output?.trim() && (
						<ToolTextPreview isError={cell.status === "error"} text={cell.output.trimEnd()} />
					)}
				</div>
			))}
			{!multi && output && (
				<div>
					{!livePreview && (
						<div
							className={
								"mb-0.5 text-omp-xxs font-semibold uppercase tracking-wider " +
								(isError ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]")
							}
						>
							{isError ? t("tools.eval.error") : t("tools.eval.output")}
						</div>
					)}
					<ToolTextPreview text={output} isError={isError} />
				</div>
			)}
			{multi && isError && !cells.some(cell => cell.status === "error" && cell.output?.trim()) && output && (
				<ToolTextPreview isError text={output} />
			)}
			{jsonOutputs.map((value, index) => (
				<JsonTree
					hideRootKeys={false}
					key={index}
					label={t("tools.eval.display", { index: index + 1 })}
					value={value}
				/>
			))}
			<ResultImages images={images} livePreview={livePreview} />
			{notice && !livePreview && <div className="text-sc-xs text-(--sc-text-subtle)">{notice}</div>}
			{truncation && !livePreview && <TruncationNote notice={truncation} />}
			{backgrounded ? (
				<div className="omp-bash-notes text-sc-xs text-(--sc-text-subtle)">
					{t("tools.bash.background", { id: backgrounded })}
				</div>
			) : null}
			{isPartial && !output && images.length === 0 && (
				<div className="text-sc-xs text-(--sc-text-muted)">{t("tools.eval.evaluating")}</div>
			)}
		</div>
	);
}
