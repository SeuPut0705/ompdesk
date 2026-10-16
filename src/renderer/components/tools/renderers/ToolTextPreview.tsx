import { AnsiText, hasAnsi } from "../../../lib/ansi";
import { cx } from "../../../lib/format";
import { PREVIEW_SCROLL_SM } from "../../../lib/preview";

/**
 * The bounded text frame tool renderers show their raw output or error in:
 * code background for output, error tint for a failed call, ANSI colours kept
 * when the text carries them.
 */
export function ToolTextPreview({
	text,
	isError = false,
	scrollClass = PREVIEW_SCROLL_SM,
}: {
	text: string;
	isError?: boolean;
	/** Height ceiling + overflow, a `lib/preview.ts` tier unless the card needs its own. */
	scrollClass?: string;
}) {
	return (
		<pre
			className={cx(
				"whitespace-pre-wrap rounded px-2 py-1.5 font-mono text-omp-sm leading-[1.45]",
				scrollClass,
				isError
					? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
					: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]",
			)}
		>
			{hasAnsi(text) ? <AnsiText text={text} /> : text}
		</pre>
	);
}
