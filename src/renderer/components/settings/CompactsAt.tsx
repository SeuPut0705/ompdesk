/**
 * "Compacts at" for one model, the fact stock's `/models` preview shows:
 * the trigger in tokens (with the percentage when percent-based), or off,
 * and which setting decides it (a `compaction.modelThresholds` key, the
 * global threshold, or the default).
 */

import type { CompactionPoint } from "../../../shared/rpc-types";
import { compactionPointValue } from "../../lib/compaction-limits";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";

/**
 * `compact`: for a dense row's model line — "850k" without a trailing ".0" and
 * without the source suffix (it stays in the tooltip).
 */
export function CompactsAt({
	point,
	className,
	compact = false,
}: {
	point: CompactionPoint;
	className?: string;
	compact?: boolean;
}) {
	const t = useT();
	const value = compactionPointValue(point, { trimZero: compact });
	const source =
		point.source === "global"
			? t("compactionLimits.source.global")
			: point.source === "default"
				? t("compactionLimits.source.default")
				: point.source;
	return (
		<span
			className={cx("tabular-nums", className)}
			data-compacts-at=""
			title={t("compactionLimits.sourceHint", { source })}
		>
			{value === null ? t("compactionLimits.compactsOff") : t("compactionLimits.compactsAt", { value })}
			{!compact && <span className="text-(--sc-text-subtle)"> · {source}</span>}
		</span>
	);
}
