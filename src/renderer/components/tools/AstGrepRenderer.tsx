import { Braces } from "lucide-react";
import { resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ToolRendererProps } from "./ToolCard";

/** AST grep: pattern header + match results. */
export function AstGrepRenderer({ args, result, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const pattern = typeof args.pattern === "string" ? args.pattern : typeof args.pat === "string" ? args.pat : "";
	const text = resultText(isPartial ? partialResult : result);

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<Braces size={12} className="shrink-0 text-[var(--omp-md-code)]" />
				<span className="truncate text-[var(--omp-text)]">{pattern || t("tools.astgrep.fallback")}</span>
			</div>
			{text ? (
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-tool-output)]">
					{text}
				</pre>
			) : (
				<div className="text-omp-sm italic text-[var(--omp-dim)]">
					{isPartial ? t("tools.astgrep.matching") : t("tools.astgrep.noMatches")}
				</div>
			)}
		</div>
	);
}
