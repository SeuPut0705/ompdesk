/**
 * Composer queue tray: the one surface for messages waiting on the agent —
 * steers (delivered at the next tool boundary of the running turn) and
 * follow-ups (delivered after the turn). It sits attached to the top edge of
 * the composer in every tab kind, so a queued message is always seen next to
 * the field that produced it. Per row: edit in place, switch lane (a
 * follow-up can be sent now as a steer; a steer can wait for the turn to
 * end), remove. The side panel's queue tab offers the same actions at full
 * size; both share useQueueActions.
 */

import { Check, CornerDownRight, ListOrdered, ListPlus, Pencil, X } from "lucide-react";
import { type KeyboardEvent, memo, useEffect, useState } from "react";
import type { RpcQueuedMessage } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { type QueueLane, useQueuedMessages } from "../../stores/queue";
import { Button, IconButton, TextArea, Tooltip } from "../common";
import { type QueueActions, useQueueActions } from "../panels/use-queue-actions";

const LANE_ICON: Record<QueueLane, typeof CornerDownRight> = {
	steering: CornerDownRight,
	followUp: ListPlus,
};

const QueueRow = memo(function QueueRow({
	item,
	lane,
	actions,
}: {
	item: RpcQueuedMessage;
	lane: QueueLane;
	actions: QueueActions;
}) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.text);
	useEffect(() => {
		if (!editing) setDraft(item.text);
	}, [editing, item.text]);

	const LaneIcon = LANE_ICON[lane];
	const laneName = t(`queuePanel.lane.${lane}`);
	const moveLabel = lane === "followUp" ? t("composerQueue.sendNow") : t("composerQueue.sendLater");
	const MoveIcon = lane === "followUp" ? CornerDownRight : ListPlus;
	const notConnected = actions.ready ? undefined : t("common.notConnected");

	const cancelEdit = () => {
		setDraft(item.text);
		setEditing(false);
	};
	const saveEdit = () => {
		const next = draft.trim();
		if (next.length > 0 && next !== item.text) actions.edit(lane, item.id, next);
		setEditing(false);
	};
	const onEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "Escape") {
			// Claim the key: the app-wide Escape would abort the running turn.
			event.preventDefault();
			event.stopPropagation();
			cancelEdit();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			saveEdit();
		}
	};

	if (editing) {
		return (
			<li className="flex flex-col gap-1.5 px-1 py-1">
				<TextArea
					aria-label={t("queuePanel.editInput")}
					autoFocus
					autoGrow
					className="max-h-40 py-1.5 text-sc-sm"
					onChange={event => setDraft(event.target.value)}
					onKeyDown={onEditKeyDown}
					rows={1}
					value={draft}
				/>
				<div className="flex items-center justify-end gap-1">
					<span className="mr-auto text-sc-xs text-(--sc-text-subtle)">{t("composerQueue.editHint")}</span>
					<Button onClick={cancelEdit} size="sm" variant="ghost">
						{t("queuePanel.cancelEdit")}
					</Button>
					<Button
						disabled={!actions.ready || draft.trim().length === 0}
						icon={<Check aria-hidden />}
						onClick={saveEdit}
						size="sm"
						variant="secondary"
					>
						{t("queuePanel.saveEdit")}
					</Button>
				</div>
			</li>
		);
	}

	return (
		<li className="group/queue flex min-h-8 items-center gap-2 rounded-(--sc-radius-sm) pr-0.5 pl-2 transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover)">
			<Tooltip content={laneName} describe={false}>
				<span className="inline-flex shrink-0 text-(--sc-text-muted)">
					<LaneIcon aria-hidden className="size-(--sc-icon-sm)" />
					<span className="sr-only">{laneName}</span>
				</span>
			</Tooltip>
			<span className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text-secondary)" title={item.text}>
				{item.text || "…"}
			</span>
			{(item.images?.length ?? 0) > 0 && (
				<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)" data-queue-images>
					{t("composerQueue.images", {
						count: item.images?.length ?? 0,
						plural: item.images?.length === 1 ? "" : "s",
					})}
				</span>
			)}
			<span className="flex shrink-0 items-center opacity-0 transition-opacity duration-(--sc-duration-instant) group-hover/queue:opacity-100 group-focus-within/queue:opacity-100 [@media(hover:none)]:opacity-100">
				{item.editable && (
					<IconButton
						disabled={!actions.ready}
						icon={<Pencil />}
						label={notConnected ?? t("queuePanel.edit")}
						onClick={() => setEditing(true)}
						size="sm"
					/>
				)}
				<IconButton
					disabled={!actions.ready}
					icon={<MoveIcon />}
					label={notConnected ?? moveLabel}
					onClick={() => actions.moveToLane(lane, item.id)}
					size="sm"
				/>
				<IconButton
					className="hover:text-(--sc-danger)"
					disabled={!actions.ready}
					icon={<X />}
					label={notConnected ?? t("queuePanel.remove")}
					onClick={() => actions.remove(lane, item.id)}
					size="sm"
				/>
			</span>
		</li>
	);
});

export function ComposerQueue() {
	const t = useT();
	const { steering, followUp } = useQueuedMessages();
	const actions = useQueueActions();
	const total = steering.length + followUp.length;
	if (total === 0) return null;

	const clearAll = () => {
		if (steering.length > 0) actions.clearLane("steering");
		if (followUp.length > 0) actions.clearLane("followUp");
	};

	// The tray sits behind the composer's top edge: it runs down under the
	// composer's rounded corners (negative margin, matching padding), so tray and
	// composer read as one stacked unit with no gap at the corners.
	return (
		<section
			aria-label={t("composerQueue.title")}
			className="omp-composer-queue omp-fade-up mx-3 -mb-(--sc-radius-xl) overflow-hidden rounded-t-(--sc-radius-lg) border border-b-0 border-(--sc-border-subtle) bg-(--sc-surface-1) pb-(--sc-radius-xl)"
		>
			<div className="flex h-8 items-center gap-1.5 pr-1 pl-3 text-sc-xs text-(--sc-text-muted)">
				<ListOrdered aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="truncate font-medium text-(--sc-text-secondary)">{t("composerQueue.title")}</span>
				<span className="shrink-0 tabular-nums">{total}</span>
				<span className="min-w-1 flex-1" />
				<Button
					className="h-6 px-2 text-sc-xs"
					disabled={!actions.ready}
					onClick={clearAll}
					size="sm"
					title={actions.ready ? undefined : t("common.notConnected")}
					variant="ghost"
				>
					{t("composerQueue.clearAll")}
				</Button>
			</div>
			<ul className="max-h-36 overflow-y-auto overscroll-contain px-1 pb-1.5">
				{steering.map(item => (
					<QueueRow actions={actions} item={item} key={item.id} lane="steering" />
				))}
				{followUp.map(item => (
					<QueueRow actions={actions} item={item} key={item.id} lane="followUp" />
				))}
			</ul>
		</section>
	);
}
