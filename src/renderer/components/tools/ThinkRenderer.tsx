import { MarkdownRenderer } from "../../lib/markdown";
import type { ToolRendererProps } from "./ToolCard";

/**
 * Stock's hidden `think` tool (pi-tui `tools/think.ts`): the private
 * scratchpad `args.thoughts` as muted markdown, styled like a reasoning block.
 * Its result (`------`, `details: { recorded: true }`) is for the model and is
 * never shown, as in stock's `renderResult(): undefined`.
 */
export function ThinkRenderer({ args }: ToolRendererProps) {
	const thoughts = typeof args.thoughts === "string" ? args.thoughts : "";
	if (!thoughts.trim()) return null;
	return (
		<div className="omp-thinking-body text-sc-sm text-(--sc-text-muted)" data-tool-think>
			<MarkdownRenderer content={thoughts} />
		</div>
	);
}
