import { Code2 } from "lucide-react";
import { extractImageDataUrls, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { asRecord } from "../../lib/wire-value";
import { CodeBlock } from "../chat/CodeBlock";
import { stripBackgroundNotice } from "./BashRenderer";
import { ResultImages } from "./ResultImages";
import type { ToolRendererProps } from "./ToolCard";
import { ToolTextPreview } from "./ToolTextPreview";

/** Eval: code cell with language badge + output below. */
export function EvalRenderer({ args, result, isError, isPartial, partialResult, livePreview }: ToolRendererProps) {
	const t = useT();
	const code = typeof args.code === "string" ? args.code : "";
	const language =
		typeof args.language === "string" ? (args.language === "py" ? "python" : args.language) : "javascript";
	const title = typeof args.title === "string" ? args.title : "";
	const effective = isPartial ? partialResult : result;
	// A cell stock moved to the background ends with the same notice as a command (eval.ts):
	// restate it as the job note instead of printing the model-facing instructions.
	const job = asRecord(resultDetails(effective)?.async);
	const backgrounded = job?.state === "running" && typeof job.jobId === "string" ? job.jobId : null;
	const text = resultText(effective);
	const output = backgrounded ? stripBackgroundNotice(text, backgrounded) : text;
	const images = extractImageDataUrls(effective);

	return (
		<div className={livePreview ? "omp-tool-editor omp-tool-eval flex flex-col gap-1.5" : "flex flex-col gap-1.5"}>
			{!livePreview && title && (
				<div className="flex items-center gap-1.5 text-omp-sm">
					<Code2 size={12} className="text-[var(--omp-dim)]" />
					<span className="font-medium text-[var(--omp-text)]">{title}</span>
				</div>
			)}
			{code && (
				<CodeBlock
					code={code}
					language={language}
					showLanguage={!livePreview}
					showCopy={false}
					maxHeightClass="max-h-64"
				/>
			)}
			{output && (
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
			<ResultImages images={images} livePreview={livePreview} />
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
