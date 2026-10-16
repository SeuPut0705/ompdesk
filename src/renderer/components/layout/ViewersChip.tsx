import { Eye } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { Badge } from "../common/Badge";

/**
 * "👁 N": other devices that show this tab too (multi-viewer, main's `viewerCount`). It counts the other
 * devices from either side: a viewer's count is the owner plus the other viewers, and the owner's is its
 * viewers. Nothing renders while the tab is only here.
 */
export function ViewersChip() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const count = useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.viewerCount ?? 0);
	if (count <= 0) return null;
	const label = t(count === 1 ? "viewers.chipOne" : "viewers.chipMany", { count });
	return (
		<span
			aria-label={label}
			className="mr-1 flex shrink-0 items-center"
			data-viewers-chip=""
			data-viewers-count={count}
			role="status"
			title={label}
		>
			<Badge variant="info">
				<Eye aria-hidden className="size-3" />
				<span aria-hidden>{count}</span>
			</Badge>
		</span>
	);
}
