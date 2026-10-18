/**
 * The queued messages a Stop withdrew, held apart from the draft ("Queue paused because you stopped"). Stock's
 * Stop takes every steer and follow-up back (`abort_and_restore_queue`); merging them into the field made them look
 * like the user's own typing and sent them out as one prompt. Here each stays its own row: Resume sends them in
 * order (the first starts the turn again, the rest queue behind it), "Put in the field" edits one, remove drops
 * one. Nothing is sent until the user chooses. While this is mounted Stop keeps them here
 * (`composer.restoredTrayMounted`); without it Stop merges them into the draft.
 *
 * It sits attached to the composer's top edge like the live queue (ComposerQueue), above or below it.
 * `onSettled`: a row's control left with its row; the composer takes focus back.
 */

import { CornerDownRight, ListPlus, Pause, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { resumeRestoredQueue } from "../../../lib/messages";
import { queueChipLabel } from "../../../lib/queue-chip";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type RestoredQueueItem, useComposerStore } from "../../../stores/composer";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { Button, IconButton, Tooltip } from "../../common";

function HeldRow({ item, onSettled }: { item: RestoredQueueItem; onSettled: () => void }) {
	const t = useT();
	const dropRestored = useComposerStore(state => state.dropRestored);
	const restoreHeldToDraft = useComposerStore(state => state.restoreHeldToDraft);
	const LaneIcon = item.lane === "steering" ? CornerDownRight : ListPlus;
	const laneName = t(`queuePanel.lane.${item.lane}`);
	const label = queueChipLabel(item.text, item.images.length);
	return (
		<li
			className="group/queue flex min-h-8 items-center gap-2 rounded-(--sc-radius-sm) pr-0.5 pl-2 transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover)"
			data-restored-item
		>
			<Tooltip content={laneName} describe={false}>
				<span className="inline-flex shrink-0 text-(--sc-text-muted)">
					<LaneIcon aria-hidden className="size-(--sc-icon-sm)" />
					<span className="sr-only">{laneName}</span>
				</span>
			</Tooltip>
			<span className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text-secondary)" title={label}>
				{label}
			</span>
			{item.images.length > 0 && item.text !== "" && (
				<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)">
					{t("composerQueue.images", { count: item.images.length, plural: item.images.length === 1 ? "" : "s" })}
				</span>
			)}
			<span className="flex shrink-0 items-center opacity-0 transition-opacity duration-(--sc-duration-instant) group-hover/queue:opacity-100 group-focus-within/queue:opacity-100 [@media(hover:none)]:opacity-100">
				<IconButton
					icon={<Pencil />}
					label={t("composerQueue.pausedEdit")}
					onClick={() => {
						restoreHeldToDraft(item.id);
						onSettled();
					}}
					size="sm"
				/>
				<IconButton
					className="hover:text-(--sc-danger)"
					icon={<X />}
					label={t("composerQueue.pausedRemove")}
					onClick={() => {
						dropRestored(item.id);
						onSettled();
					}}
					size="sm"
				/>
			</span>
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
			className="omp-composer-queue omp-fade-up mx-3 -mb-(--sc-radius-xl) overflow-hidden rounded-t-(--sc-radius-lg) border border-b-0 border-(--sc-border-subtle) bg-(--sc-surface-1) pb-(--sc-radius-xl)"
			data-restored-queue
		>
			<div className="flex h-8 items-center gap-1.5 pr-1 pl-3 text-sc-xs text-(--sc-text-muted)">
				<Pause aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="truncate font-medium text-(--sc-text-secondary)" role="status">
					{t("composerQueue.paused")}
				</span>
				<span className="shrink-0 tabular-nums">{items.length}</span>
				<span className="min-w-1 flex-1" />
				<Button
					className="h-6 px-2 text-sc-xs"
					onClick={() => {
						clearRestored();
						onSettled();
					}}
					size="sm"
					variant="ghost"
				>
					{t("composerQueue.pausedDiscard")}
				</Button>
				<Button
					className="h-6 px-2 text-sc-xs"
					disabled={!ready || resuming}
					onClick={resume}
					size="sm"
					title={ready ? undefined : t("common.notConnected")}
					variant="secondary"
				>
					{t("composerQueue.resume")}
				</Button>
			</div>
			<ul className="max-h-36 overflow-y-auto overscroll-contain px-1 pb-1.5">
				{items.map(item => (
					<HeldRow item={item} key={item.id} onSettled={onSettled} />
				))}
			</ul>
		</section>
	);
}
