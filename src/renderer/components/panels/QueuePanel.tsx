/**
 * Queue panel: the agent's pending message queue as two lanes — Steer
 * (delivered mid-run) and Follow-up (delivered after the
 * run). Mutations (edit, remove, lane clear, and the lane switch: a follow-up
 * is sent now as a steer through stock promotion, a steer can wait for the
 * turn to end) come from useQueueActions, shared with the composer's
 * queued-message tray.
 */

import { Check, CornerDownRight, ListPlus, ListX, Pencil, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { RpcQueuedMessage } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { formatShortcut, onEscape } from "../../lib/keymap";
import { type QueueLane, useQueuedMessages } from "../../stores/queue";
import { Badge, EmptyState, IconButton } from "../common";
import { PANEL_ROW_SURFACE } from "./PanelChrome";
import { useQueueActions } from "./use-queue-actions";

interface QueuedRowProps {
	item: RpcQueuedMessage;
	lane: QueueLane;
	onEdit: (lane: QueueLane, id: string, text: string) => void;
	onMoveToLane: (lane: QueueLane, id: string) => void;
	onRemove: (lane: QueueLane, id: string) => void;
	removeLabel: string;
	ready: boolean;
}

const QueuedRow = memo(function QueuedRow({
	item,
	lane,
	onEdit,
	onMoveToLane,
	onRemove,
	removeLabel,
	ready,
}: QueuedRowProps) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.text);
	const t = useT();
	// Stock promotes only follow-ups (promote_queued_message), so "Send now" is a follow-up action.
	const moveLabel = lane === "followUp" ? t("composerQueue.sendNow") : t("composerQueue.sendLater");
	const MoveIcon = lane === "followUp" ? CornerDownRight : ListPlus;
	useEffect(() => {
		if (!editing) setDraft(item.text);
	}, [editing, item.text]);
	const saveEdit = () => {
		const text = draft.trim();
		if (text.length > 0 && text !== item.text) onEdit(lane, item.id, text);
		setDraft(text.length > 0 ? text : item.text);
		setEditing(false);
	};
	return (
		<div className={`group flex items-start gap-2 ${PANEL_ROW_SURFACE}`}>
			{editing ? (
				<div className="min-w-0 flex-1">
					<textarea
						aria-label={t("queuePanel.editInput")}
						autoFocus
						className="w-full resize-y rounded-(--sc-radius-md) border border-(--sc-accent-border) bg-(--sc-field) px-2 py-1 text-sc-sm leading-(--sc-leading-snug) text-(--sc-text)"
						onInput={event => setDraft(event.currentTarget.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							onEscape(event, () => {
								setDraft(item.text);
								setEditing(false);
							});
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								saveEdit();
							}
						}}
						rows={2}
						value={draft}
					/>
					<div className="mt-1 flex justify-end gap-1">
						<IconButton
							icon={<X />}
							label={t("queuePanel.cancelEdit")}
							onClick={() => {
								setDraft(item.text);
								setEditing(false);
							}}
							size="sm"
						/>
						<IconButton
							icon={<Check />}
							label={t("queuePanel.saveEdit")}
							disabled={!ready || draft.trim().length === 0}
							onClick={saveEdit}
							shortcut={formatShortcut("⌘↵")}
							size="sm"
						/>
					</div>
				</div>
			) : (
				<>
					<span className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-sc-sm leading-(--sc-leading-normal) text-(--sc-text)">
						{item.text || "…"}
					</span>
					{item.editable && (
						<IconButton
							icon={<Pencil />}
							label={t("queuePanel.edit")}
							disabled={!ready}
							onClick={() => setEditing(true)}
							size="sm"
						/>
					)}
					<IconButton
						icon={<MoveIcon />}
						label={moveLabel}
						disabled={!ready}
						onClick={() => onMoveToLane(lane, item.id)}
						size="sm"
					/>
					<IconButton
						icon={<X />}
						label={removeLabel}
						disabled={!ready}
						onClick={() => onRemove(lane, item.id)}
						size="sm"
					/>
				</>
			)}
		</div>
	);
});

function LaneSection({
	lane,
	items,
	onRemove,
	onEdit,
	onClear,
	onMoveToLane,
	ready,
}: {
	lane: QueueLane;
	items: RpcQueuedMessage[];
	onRemove: (lane: QueueLane, id: string) => void;
	onEdit: (lane: QueueLane, id: string, text: string) => void;
	onClear: (lane: QueueLane) => void;
	onMoveToLane: (lane: QueueLane, id: string) => void;
	ready: boolean;
}) {
	const t = useT();
	return (
		<section className="mb-3">
			<div className="flex items-center gap-1.5 px-2 py-1.5">
				<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text-muted)">
					{t(lane === "steering" ? "queuePanel.lane.steering" : "queuePanel.lane.followUp")}
				</span>
				<Badge variant="muted">{items.length}</Badge>
				{items.length > 0 && (
					<button
						aria-label={t("queuePanel.clearLane")}
						className="omp-pressable flex items-center gap-1 rounded-md px-2 py-1 text-omp-xs text-(--omp-dim) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-error) disabled:opacity-40"
						disabled={!ready}
						onClick={() => onClear(lane)}
						title={!ready ? t("common.notConnected") : undefined}
						type="button"
					>
						<ListX size={12} />
						{t("queuePanel.clearLane")}
					</button>
				)}
			</div>
			<div className="flex flex-col gap-1.5 px-1">
				{items.map(item => (
					<QueuedRow
						item={item}
						key={item.id}
						onEdit={onEdit}
						lane={lane}
						onMoveToLane={onMoveToLane}
						onRemove={onRemove}
						removeLabel={t("queuePanel.remove")}
						ready={ready}
					/>
				))}
				{items.length === 0 && (
					<div className="py-1 text-omp-sm text-(--omp-dim) italic">{t("queuePanel.laneEmpty")}</div>
				)}
			</div>
		</section>
	);
}

export function QueuePanel() {
	const t = useT();
	const { steering, followUp } = useQueuedMessages();
	const total = steering.length + followUp.length;
	const { ready: sidecarReady, remove: removeItem, edit: editItem, moveToLane, clearLane } = useQueueActions();

	return (
		<div className="flex h-full flex-col">
			{!sidecarReady && (
				<div
					className="mx-2 mt-2 rounded-md border border-(--omp-border-muted) px-2.5 py-2 text-omp-xs text-(--omp-muted)"
					role="status"
				>
					{t("common.notConnected")}
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				{total === 0 ? (
					<EmptyState
						icon={<ListX />}
						size="sm"
						title={t("queuePanel.empty")}
						description={t("queuePanel.emptyHint")}
					/>
				) : (
					<>
						<LaneSection
							items={steering}
							lane="steering"
							onEdit={editItem}
							onClear={clearLane}
							onMoveToLane={moveToLane}
							onRemove={removeItem}
							ready={sidecarReady}
						/>
						<LaneSection
							items={followUp}
							lane="followUp"
							onEdit={editItem}
							onClear={clearLane}
							onMoveToLane={moveToLane}
							onRemove={removeItem}
							ready={sidecarReady}
						/>
					</>
				)}
			</div>
		</div>
	);
}
