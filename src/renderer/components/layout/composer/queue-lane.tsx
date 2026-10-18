/**
 * What every view of the queue shares: the lane names ("After next step" / "After this turn"), the heading above a
 * lane's rows, and how a row is named for assistive tech. The composer's queue popover and the side panel's Queue tab
 * both draw from here, so the two never call the same lane differently (DR-7).
 */

import { Image as ImageIcon } from "lucide-react";
import type { ImageContent } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { queueChipLabel } from "../../../lib/queue-chip";
import type { QueueLane } from "../../../stores/queue";

/** Characters of a message that name its row's buttons ("Edit: <first 40 chars>", DR-11). */
const ROW_NAME_CHARS = 40;

/** A row's name: the start of its text on one line, or the picture-only label. */
export function queueRowName(text: string, imageCount = 0): string {
	const label = queueChipLabel(text, imageCount).replace(/\s+/g, " ").trim();
	return label.length > ROW_NAME_CHARS ? `${label.slice(0, ROW_NAME_CHARS - 1)}…` : label;
}

/** The lane's heading: its name, how many wait in it and how they are delivered. */
export function QueueLaneHeading({ lane, count }: { lane: QueueLane; count: number }) {
	const t = useT();
	return (
		<div
			className="flex h-5 items-center gap-1.5 px-2 text-sc-xs font-medium text-(--sc-text-subtle)"
			data-lane-head={lane}
			title={t(`composerQueue.laneTip.${lane}`)}
		>
			<span className="shrink-0">{t(`composerQueue.lane.${lane}`)}</span>
			<span className="shrink-0 tabular-nums">{count}</span>
			<span className="min-w-0 truncate font-normal">· {t(`composerQueue.laneSub.${lane}`)}</span>
		</div>
	);
}

/** Picture tiles of a queued message (at most three, then "+N"); a tile is the picture itself while the renderer still has it. */
export function QueueImageTiles({ images, count }: { images?: ImageContent[]; count: number }) {
	const t = useT();
	return (
		<span className="inline-flex shrink-0 items-center gap-0.5" data-queue-images>
			{Array.from({ length: Math.min(count, 3) }, (_, index) => {
				const image = images?.[index];
				return (
					<span
						className="inline-flex size-5 items-center justify-center overflow-hidden rounded-(--sc-radius-xs) border border-(--sc-border-subtle) bg-(--sc-surface-2) text-(--sc-text-muted)"
						key={index}
					>
						{image ? (
							<img
								alt=""
								className="size-full object-cover"
								src={`data:${image.mimeType};base64,${image.data}`}
							/>
						) : (
							<ImageIcon aria-hidden className="size-3" />
						)}
					</span>
				);
			})}
			{count > 3 && (
				<span aria-hidden className="text-sc-xs tabular-nums text-(--sc-text-muted)">
					+{count - 3}
				</span>
			)}
			<span className="sr-only">{t("composerQueue.images", { count, plural: count === 1 ? "" : "s" })}</span>
		</span>
	);
}
