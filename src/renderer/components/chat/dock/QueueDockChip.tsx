/**
 * Queue dock chip: the pending-message queue's center-dock surface. The
 * queued messages themselves already render inline as grey bubbles at the
 * transcript tail (per-item remove included); this chip carries the counts
 * and opens the full manager (lane switch, edit, remove, lane clear) in the
 * side panel's queue tab.
 */

import { ListOrdered } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { useQueuedMessages } from "../../../stores/queue";
import { useUiStore } from "../../../stores/ui";
import { Button } from "../../common";

export function QueueDockChip() {
	const t = useT();
	const { steering, followUp } = useQueuedMessages();

	if (steering.length + followUp.length === 0) return null;

	const parts: string[] = [];
	if (followUp.length > 0) parts.push(`${t("dock.queue.label")} ${followUp.length}`);
	if (steering.length > 0) parts.push(`${t("dock.queue.steering")} ${steering.length}`);

	return (
		<div className="flex shrink-0 px-2">
			<Button
				className="rounded-(--sc-radius-full) tabular-nums"
				icon={<ListOrdered aria-hidden="true" />}
				onClick={() => useUiStore.getState().setPanelTab("queue")}
				size="sm"
				title={t("dock.queue.manage")}
				variant="secondary"
			>
				{parts.join(" · ")}
			</Button>
		</div>
	);
}
