/**
 * ErrorDetail — the raw technical cause of a failure, as the quiet secondary
 * line under a localized sentence (a Banner title, an EmptyState title, an
 * inline error heading). Never the headline itself; see Toast's `detail` for
 * the same rule in toasts. Renders nothing when the cause has no text.
 *
 * `raw` shows the original text whole, as written: a command's stderr, a
 * provider's error body, every line kept, in a mono block that scrolls past
 * ten lines and stays selectable. A text given as a string is shown untouched;
 * an Error or a failed result shows its message.
 */

import { errorDetail } from "../../lib/error-detail";
import { cx } from "../../lib/format";

export function ErrorDetail({ error, raw, className }: { error: unknown; raw?: boolean; className?: string }) {
	const text = raw && typeof error === "string" ? error : errorDetail(error);
	if (!text.trim()) return null;
	if (raw) {
		return (
			<pre
				className={cx(
					"max-h-40 overflow-y-auto font-mono text-sc-xs break-words whitespace-pre-wrap text-(--sc-text-muted) select-text",
					className,
				)}
				data-error-detail="raw"
			>
				{text}
			</pre>
		);
	}
	return (
		<span
			className={cx("block font-mono text-sc-xs break-all text-(--sc-text-muted) select-text", className)}
			data-error-detail
		>
			{text}
		</span>
	);
}
