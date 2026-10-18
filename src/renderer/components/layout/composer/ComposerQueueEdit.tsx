/**
 * Edit queued: the composer field takes a queued message over (`composer.editingQueued`). A banner says so
 * ("Edit queued · Saves as last in “After this turn” · Cancel"), the field holds the message, Send becomes a check that
 * saves, and Cancel or Esc puts the exact previous draft (text and pictures) back. Saving calls the queue's own edit
 * (stock re-queues the message at the end of its lane). If the message was delivered or removed meanwhile, the edit
 * ends by itself: the edited text goes ahead of the restored draft, nothing is lost and nothing is sent.
 */

import { useCallback, useEffect } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { expandPasteMarkers } from "../../../lib/paste-blobs";
import { useComposerStore } from "../../../stores/composer";
import { useQueuedMessages } from "../../../stores/queue";
import { toast } from "../../../stores/toast";
import { Badge, Button } from "../../common";
import { useQueueActions } from "../../panels/use-queue-actions";
import { queueRowName } from "./queue-lane";
import { useStableCallback } from "./use-stable-callback";

/** Save and cancel of the queued message the field is editing; `editing` is null when none is. */
export function useComposerQueueEdit() {
	const editing = useComposerStore(state => state.editingQueued);
	const endEdit = useComposerStore(state => state.endEditQueued);
	const actions = useQueueActions();
	/** Save `text` (the field's draft) as the queued message; true when the edit ended. */
	const save = useStableCallback((text: string): boolean => {
		const next = expandPasteMarkers(text).trim();
		if (!editing || !actions.ready || next === "") return false;
		if (next !== editing.original) actions.edit(editing.lane, editing.id, next);
		endEdit();
		return true;
	});
	const cancel = useCallback(() => endEdit(), [endEdit]);
	return { editing, save, cancel };
}

/** The banner above the field while a queued message is edited. `onCancel` also hands focus back to the field. */
export function ComposerEditBanner({ onCancel }: { onCancel: () => void }) {
	const t = useT();
	const editing = useComposerStore(state => state.editingQueued);
	const draft = useComposerStore(state => state.draft);
	const endEdit = useComposerStore(state => state.endEditQueued);
	const { steering, followUp } = useQueuedMessages();
	const present = editing !== null && [...steering, ...followUp].some(item => item.id === editing.id);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the message vanishing ends the edit, not each keystroke
	useEffect(() => {
		if (!editing || present) return;
		toast({
			variant: "info",
			message: t("composerQueue.editGone", { text: queueRowName(editing.original) }),
		});
		endEdit(draft.trim() !== "" && draft !== editing.original ? draft : undefined);
	}, [editing?.id, present]);
	if (!editing) return null;
	return (
		<div
			className={cx(
				"flex h-9 shrink-0 items-center gap-2 rounded-t-(--sc-radius-xl) bg-(--sc-accent-soft) pr-1.5 pl-3 text-sc-sm text-(--sc-text) [--hit-gap-x:8px] [--hit-gap-y:0px]",
			)}
			data-queue-edit-banner
		>
			<Badge variant="accent">{t("composerQueue.editBanner")}</Badge>
			<span
				className="min-w-0 flex-1 truncate text-sc-xs text-(--sc-text-muted)"
				title={t("composerQueue.editRestore")}
			>
				{t("composerQueue.editSaves", { lane: t(`composerQueue.lane.${editing.lane}`) })}
			</span>
			<Button data-queue-edit-cancel onClick={onCancel} size="sm" variant="ghost">
				{t("queuePanel.cancelEdit")}
			</Button>
		</div>
	);
}
