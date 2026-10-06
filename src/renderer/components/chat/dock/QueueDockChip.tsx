/**
 * Queue dock chip: the pending-message queue's center-dock surface. The
 * queued messages themselves already render inline as grey bubbles at the
 * transcript tail (per-item remove included); this chip carries the counts
 * and opens the full manager (lane switch, edit, remove, lane clear) in
 * a modal — the workspace drawer's queue tab after the dock migration.
 */

import { ListOrdered } from "lucide-react";
import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { useQueuedMessages } from "../../../stores/queue";
import { Modal } from "../../common";
import { QueuePanel } from "../../panels/QueuePanel";

export function QueueDockChip() {
	const t = useT();
	const { steering, followUp } = useQueuedMessages();
	const [open, setOpen] = useState(false);

	const total = steering.length + followUp.length;
	if (total === 0 && !open) return null;

	return (
		<>
			<div className="flex shrink-0 px-2">
				<button
					type="button"
					onClick={() => setOpen(true)}
					title={t("dock.queue.manage")}
					className="omp-pressable flex items-center gap-1.5 rounded-full border border-[var(--omp-border)] px-2.5 py-1 text-omp-sm font-medium text-[var(--omp-muted)] hover:border-[var(--omp-border-strong)] hover:text-[var(--omp-text)]"
				>
					<ListOrdered aria-hidden="true" size={12} />
					<span>
						{t("dock.queue.label")} <span className="tabular-nums text-[var(--omp-text)]">{followUp.length}</span>
					</span>
					<span aria-hidden="true" className="text-[var(--omp-dim)]">
						·
					</span>
					<span>
						{t("dock.queue.steering")}{" "}
						<span className="tabular-nums text-[var(--omp-text)]">{steering.length}</span>
					</span>
				</button>
			</div>
			<Modal
				bodyClassName="p-0"
				onClose={() => setOpen(false)}
				open={open}
				size="lg"
				title={
					<span className="flex items-center gap-2">
						{t("queuePanel.title")}
						<span className="text-omp-md font-normal tabular-nums text-[var(--omp-dim)]">{total}</span>
					</span>
				}
			>
				<div className="max-h-[70vh] overflow-y-auto">
					<QueuePanel />
				</div>
			</Modal>
		</>
	);
}
