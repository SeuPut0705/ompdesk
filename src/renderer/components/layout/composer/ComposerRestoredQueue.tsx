/**
 * The queued messages a Stop withdrew, held apart from the draft ("Queue paused because you stopped"). Stock's Stop
 * takes every steer and follow-up back (`abort_and_restore_queue`); merging them into the field made them look like
 * the user's own typing and sent them out as one prompt. Here each stays its own removable chip: Resume sends them in
 * order (the first starts the turn again, the rest queue behind it), a chip's text puts that one in the field to edit,
 * its × drops it, Discard drops all. Nothing is sent until the user chooses. While this is mounted Stop keeps them here
 * (`composer.restoredTrayMounted`); without it Stop merges them into the draft.
 *
 * ONE 36 px row at the top of the composer box, on every width: the sentence and the chips scroll together, Resume and
 * Discard stay put at the end. `onSettled`: a control left with its row; the composer takes focus back.
 */

import { CornerDownRight, ListPlus, Pause, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { resumeRestoredQueue } from "../../../lib/messages";
import { queueChipLabel } from "../../../lib/queue-chip";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type RestoredQueueItem, useComposerStore } from "../../../stores/composer";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { Button, IconButton, Tooltip } from "../../common";
import { QueueImageTiles, queueRowName } from "./queue-lane";

function HeldChip({ item, onSettled }: { item: RestoredQueueItem; onSettled: () => void }) {
	const t = useT();
	const dropRestored = useComposerStore(state => state.dropRestored);
	const restoreHeldToDraft = useComposerStore(state => state.restoreHeldToDraft);
	const LaneIcon = item.lane === "steering" ? CornerDownRight : ListPlus;
	const laneName = t(`composerQueue.lane.${item.lane}`);
	const name = queueRowName(item.text, item.images.length);
	return (
		<li
			className="inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-full border border-(--sc-border-subtle) bg-(--sc-surface-2) pr-0.5 pl-2.5 text-sc-xs text-(--sc-text-secondary)"
			data-restored-item
		>
			<Tooltip content={laneName} describe={false}>
				<span className="inline-flex shrink-0 text-(--sc-text-muted)">
					<LaneIcon aria-hidden className="size-(--sc-icon-sm)" />
					<span className="sr-only">{laneName}</span>
				</span>
			</Tooltip>
			<button
				aria-label={t("composerQueue.pausedEdit", { text: name })}
				className="min-w-0 truncate rounded-(--sc-radius-xs) text-left"
				onClick={() => {
					restoreHeldToDraft(item.id);
					onSettled();
				}}
				title={queueChipLabel(item.text, item.images.length)}
				type="button"
			>
				{queueChipLabel(item.text, item.images.length)}
			</button>
			{item.images.length > 0 && item.text !== "" && (
				<QueueImageTiles count={item.images.length} images={item.images.map(image => image.content)} />
			)}
			<IconButton
				className="size-6 rounded-full"
				icon={<X />}
				label={t("composerQueue.pausedRemove", { text: name })}
				onClick={() => {
					dropRestored(item.id);
					onSettled();
				}}
				size="sm"
			/>
		</li>
	);
}

export function ComposerRestoredQueue({ onSettled }: { onSettled: () => void }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const items = useComposerStore(state => state.restoredQueue);
	const clearRestored = useComposerStore(state => state.clearRestored);
	const setMounted = useComposerStore(state => state.setRestoredTrayMounted);
	const ready = useSessionStore(state => state.status) === "ready";
	const [resuming, setResuming] = useState(false);
	useEffect(() => {
		setMounted(true);
		return () => setMounted(false);
	}, [setMounted]);
	if (items.length === 0) return null;

	const resume = () => {
		setResuming(true);
		void resumeRestoredQueue(rpc, tabId).finally(() => {
			setResuming(false);
			onSettled();
		});
	};

	return (
		<section
			aria-label={t("composerQueue.pausedLabel")}
			className="omp-restored-queue flex h-9 shrink-0 items-center gap-2 pr-2 pl-3 pt-1 [--hit-gap-x:8px] [--hit-gap-y:4px]"
			data-restored-queue
		>
			<ul
				aria-label={t("composerQueue.pausedChips")}
				className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none]"
				data-restored-chips
			>
				<li className="inline-flex shrink-0 items-center gap-1.5 text-sc-xs text-(--sc-warning)" data-restored-note>
					<Pause aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="whitespace-nowrap text-(--sc-text-secondary)">{t("composerQueue.paused")}</span>
				</li>
				{items.map(item => (
					<HeldChip item={item} key={item.id} onSettled={onSettled} />
				))}
			</ul>
			<Tooltip content={t("composerQueue.resumeTip")} describe={false}>
				<Button
					data-restored-resume
					disabled={!ready || resuming}
					icon={<Play aria-hidden />}
					onClick={resume}
					size="sm"
					title={ready ? undefined : t("common.notConnected")}
					variant="secondary"
				>
					{t("composerQueue.resume")}
				</Button>
			</Tooltip>
			<Button
				aria-label={t("composerQueue.pausedDiscardAll")}
				data-restored-discard
				onClick={() => {
					clearRestored();
					onSettled();
				}}
				size="sm"
				variant="ghost"
			>
				{t("composerQueue.pausedDiscard")}
			</Button>
		</section>
	);
}
