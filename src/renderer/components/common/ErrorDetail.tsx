/**
 * ErrorDetail — the raw technical cause of a failure, as the quiet secondary
 * line under a localized sentence (a Banner title, an EmptyState title, an
 * inline error heading). Never the headline itself; see Toast's `detail` for
 * the same rule in toasts. Renders nothing when the cause has no text.
 */

import { errorDetail } from "../../lib/error-detail";
import { cx } from "../../lib/format";

export function ErrorDetail({ error, className }: { error: unknown; className?: string }) {
	const text = errorDetail(error);
	if (!text) return null;
	return (
		<span
			className={cx("block font-mono text-sc-xs break-all text-(--sc-text-muted) select-text", className)}
			data-error-detail
		>
			{text}
		</span>
	);
}
