import { Code2 } from "lucide-react";
import { AnsiText, hasAnsi } from "../../lib/ansi";
import { cx, extractImageDataUrls, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_SM } from "../../lib/preview";
import { CodeBlock } from "../chat/CodeBlock";
import { ResultImages } from "./ResultImages";
import type { ToolRendererProps } from "./ToolCard";

/** Eval: code cell with language badge + output below. */
export function EvalRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const code = typeof args.code === "string" ? args.code : "";
	const language =
		typeof args.language === "string" ? (args.language === "py" ? "python" : args.language) : "javascript";
	const title = typeof args.title === "string" ? args.title : "";
	const effective = isPartial ? partialResult : result;
	const output = resultText(effective);
	const images = extractImageDataUrls(effective);

	return (
		<div className="flex flex-col gap-1.5">
			{title && (
				<div className="flex items-center gap-1.5 text-omp-sm">
					<Code2 size={12} className="text-[var(--omp-dim)]" />
					<span className="font-medium text-[var(--omp-text)]">{title}</span>
				</div>
			)}
			{code && <CodeBlock code={code} language={language} showCopy={false} maxHeightClass="max-h-64" />}
			{output && (
				<div>
					<div
						className={
							"mb-0.5 text-omp-xxs font-semibold uppercase tracking-wider " +
							(isError ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]")
						}
					>
						{isError ? t("tools.eval.error") : t("tools.eval.output")}
					</div>
					<pre
						className={cx(
							"whitespace-pre-wrap rounded px-2 py-1.5 font-mono text-omp-sm leading-[1.45]",
							PREVIEW_SCROLL_SM,
							isError
								? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
								: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]",
						)}
					>
						{hasAnsi(output) ? <AnsiText text={output} /> : output}
					</pre>
				</div>
			)}
			<ResultImages images={images} />
			{isPartial && !output && images.length === 0 && (
				<div className="text-omp-sm italic text-[var(--omp-accent)]">{t("tools.eval.evaluating")}</div>
			)}
		</div>
	);
}
