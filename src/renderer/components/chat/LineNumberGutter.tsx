import { cx } from "../../lib/format";

export interface LineNumberGutterProps {
	lineCount: number;
	/** Number shown on the first line (ranged reads start past 1). */
	startLine?: number;
	/** Explicit per-row numbers for multi-range/elided reads; null renders a blank gutter row. */
	lineNumbers?: readonly (number | null)[];
	/**
	 * Typography metrics (font size, line-height, block padding) — they MUST
	 * match the code pane beside the gutter or numbers drift off their lines.
	 */
	className?: string;
}

/**
 * Shared sticky line-number gutter for code blocks: the tool-renderers'
 * CodeBlock (always on) and markdown code blocks (codeLineNumbers pref).
 * Extracted so both render the same gutter instead of forking it.
 */
export function LineNumberGutter({ lineCount, startLine = 1, lineNumbers, className }: LineNumberGutterProps) {
	// One preformatted text node, not one <div> per line: a 10k-line fence must
	// not create 10k elements. whitespace-pre keeps the newlines, text-right
	// keeps per-line alignment identical to the old per-row layout.
	return (
		<div
			aria-hidden
			className={cx(
				"sticky left-0 shrink-0 select-none whitespace-pre border-r border-[var(--omp-border-muted)]/50 bg-[var(--omp-code-bg)] text-right font-mono text-[var(--omp-dim)]",
				className,
			)}
		>
			{lineNumbers
				? lineNumbers.map(line => line ?? "").join("\n")
				: Array.from({ length: lineCount }, (_, i) => i + startLine).join("\n")}
		</div>
	);
}
