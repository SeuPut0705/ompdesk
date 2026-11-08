/**
 * A model drawn the way every model list draws it: its provider's mark, the compact name (`compactModelLabels`) and,
 * only where two models would read alike, the muted suffix. The caller sets the tooltip (full name, `provider/id`).
 */

import { cx } from "../../lib/format";
import { ProviderMark } from "./providers/ProviderMark";
import type { CompactModelLabel } from "./providers/provider-marks";

export function ModelLabel({
	provider,
	label,
	className,
}: {
	/** The provider id; empty draws no mark. */
	provider: string;
	label: CompactModelLabel;
	className?: string;
}) {
	return (
		<span className={cx("flex min-w-0 items-center gap-1.5", className)}>
			{provider !== "" && <ProviderMark className="size-4" provider={{ id: provider, name: provider }} />}
			<span className="flex min-w-0 items-baseline gap-1.5">
				<span className="min-w-0 truncate" data-model-name>
					{label.name}
				</span>
				{label.suffix !== undefined && (
					<span className="shrink-0 text-sc-xs text-(--sc-text-muted) tabular-nums" data-model-suffix>
						{label.suffix}
					</span>
				)}
			</span>
		</span>
	);
}
