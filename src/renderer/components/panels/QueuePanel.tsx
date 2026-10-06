import { type TabRpc, useTabRpc } from "../../lib/tab-rpc";
/**
 * Queue panel: the agent's pending message queue as two lanes — 引导
 * (steering, delivered mid-run) and 排队 (follow-up, delivered after the
 * run). The lane-switch rides queue_move with toLane (appended to the target
 * lane's end), edit rides queue_edit (omp re-queues the new text at the end
 * of its lane), per-item delete rides queue_remove, per-lane clear rides
 * queue_clear. omp cannot reorder within a lane. Mutations apply
 * optimistically, then resync from get_queue on settle so the server stays
 * the single source of truth.
 */

import { ArrowLeftRight, Check, ListX, Pencil, X } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { RpcQueuedMessage } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { formatShortcut, onEscape } from "../../lib/keymap";
import { optimisticWrite } from "../../lib/optimistic";
import { type QueueLane, type QueueStore, useQueuedMessages, useQueueStore } from "../../stores/queue";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { toast } from "../../stores/toast";
import { Badge } from "../common";

/** Apply a lane-local mutation optimistically. Failed responses and rejected
 *  transport calls roll back this mutation unless a newer snapshot superseded
 *  it, then attempt an authoritative refresh. */
async function applyLaneMutation(
	queueStore: StoreApi<QueueStore>,
	lane: QueueLane,
	optimistic: (items: RpcQueuedMessage[]) => RpcQueuedMessage[],
	persist: () => Promise<{ success: boolean; error?: string }>,
	failureKey: string,
	t: (key: string) => string,
): Promise<void> {
	await optimisticWrite({
		store: queueStore,
		mutate: state =>
			lane === "steering" ? { steering: optimistic(state.steering) } : { followUp: optimistic(state.followUp) },
		persist,
		onFailure: message => toast({ variant: "error", title: t(failureKey), message }),
		resync: () => queueStore.getState().refresh(),
	});
}

interface QueuedRowProps {
	item: RpcQueuedMessage;
	lane: QueueLane;
	onEdit: (lane: QueueLane, id: string, text: string) => void;
	onMoveToLane: (lane: QueueLane, id: string) => void;
	onRemove: (lane: QueueLane, id: string) => void;
	removeLabel: string;
	ready: boolean;
}

/** Optimistically move an entry to the END of the other lane (queue_move with
 *  toLane). Failed responses and rejected transport calls roll back unless a
 *  newer snapshot superseded this mutation, then attempt a refresh. */
async function applyCrossLaneMove(
	queueStore: StoreApi<QueueStore>,
	rpc: TabRpc,
	lane: QueueLane,
	id: string,
	t: (key: string) => string,
): Promise<void> {
	const target: QueueLane = lane === "steering" ? "followUp" : "steering";
	await optimisticWrite({
		store: queueStore,
		mutate: state => {
			const item = state[lane].find(entry => entry.id === id);
			if (!item) return {};
			const without = state[lane].filter(entry => entry.id !== id);
			return lane === "steering"
				? { steering: without, followUp: [...state.followUp, item] }
				: { steering: [...state.steering, item], followUp: without };
		},
		persist: () => rpc.queueMove(id, Number.MAX_SAFE_INTEGER, target),
		onFailure: message => toast({ variant: "error", title: t("queuePanel.moveFailed"), message }),
		resync: () => queueStore.getState().refresh(),
	});
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
	const targetLane: QueueLane = lane === "steering" ? "followUp" : "steering";
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
		<div className="group flex items-start gap-2 rounded-lg border border-(--omp-border-muted) bg-transparent px-2.5 py-2">
			{editing ? (
				<div className="min-w-0 flex-1">
					<textarea
						aria-label={t("queuePanel.editInput")}
						autoFocus
						className="w-full resize-y rounded-md border border-(--omp-input-focus-border) bg-(--omp-input-bg) px-2 py-1 text-omp-md leading-snug text-(--omp-text) outline-none"
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
						<button
							aria-label={t("queuePanel.cancelEdit")}
							className="omp-pressable rounded-sm p-1 text-(--omp-dim) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
							onClick={() => {
								setDraft(item.text);
								setEditing(false);
							}}
							title={t("queuePanel.cancelEdit")}
							type="button"
						>
							<X size={12} />
						</button>
						<button
							aria-label={t("queuePanel.saveEdit")}
							className="omp-pressable rounded-sm p-1 text-(--omp-accent) hover:bg-(--omp-bg-tertiary) disabled:cursor-not-allowed disabled:opacity-40"
							disabled={!ready || draft.trim().length === 0}
							onClick={saveEdit}
							title={t("queuePanel.saveEditHint", { shortcut: formatShortcut("⌘↵") })}
							type="button"
						>
							<Check size={12} />
						</button>
					</div>
				</div>
			) : (
				<>
					<span className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-omp-md leading-snug text-(--omp-text)">
						{item.text || "…"}
					</span>
					{item.editable && (
						<button
							aria-label={t("queuePanel.edit")}
							className="omp-pressable mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-(--omp-dim) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
							disabled={!ready}
							onClick={() => setEditing(true)}
							title={t("queuePanel.edit")}
							type="button"
						>
							<Pencil size={14} />
						</button>
					)}
					<button
						aria-label={t("queuePanel.moveToLane", { lane: t(`queuePanel.lane.${targetLane}`) })}
						className="omp-pressable mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-(--omp-dim) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
						disabled={!ready}
						onClick={() => onMoveToLane(lane, item.id)}
						title={
							!ready
								? t("common.notConnected")
								: t("queuePanel.moveToLane", { lane: t(`queuePanel.lane.${targetLane}`) })
						}
						type="button"
					>
						<ArrowLeftRight size={14} />
					</button>
					<button
						aria-label={removeLabel}
						className="omp-pressable mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-(--omp-dim) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-error)"
						disabled={!ready}
						onClick={() => onRemove(lane, item.id)}
						title={!ready ? t("common.notConnected") : removeLabel}
						type="button"
					>
						<X size={14} />
					</button>
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
				<span className="min-w-0 flex-1 truncate text-omp-sm font-semibold tracking-wide text-(--omp-accent) uppercase">
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
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const queueStore = sessionRuntimeStore<QueueStore>(tabId, "queue") ?? useQueueStore;
	const t = useT();
	const sessionStore = sessionRuntimeStore<SessionStore>(tabId, "session");
	const sidecarReady = useStore(sessionStore ?? useSessionStore, state => state.status) === "ready";
	const { steering, followUp } = useQueuedMessages();
	const total = steering.length + followUp.length;

	const removeItem = useCallback(
		(lane: QueueLane, id: string) => {
			if (!sidecarReady) return;
			void applyLaneMutation(
				queueStore,
				lane,
				items => items.filter(item => item.id !== id),
				() => tabRpc.queueRemove(id),
				"queuePanel.removeFailed",
				t,
			);
		},
		[sidecarReady, t, tabRpc.queueRemove, queueStore],
	);

	const editItem = useCallback(
		(lane: QueueLane, id: string, text: string) => {
			if (!sidecarReady) return;
			void applyLaneMutation(
				queueStore,
				lane,
				items => {
					// omp re-queues edited text at the end of its lane.
					const edited = items.find(item => item.id === id);
					return edited ? [...items.filter(item => item.id !== id), { ...edited, text }] : items;
				},
				async () => {
					const response = await tabRpc.queueEdit(id, text);
					return response.success
						? { success: true as const }
						: { success: false as const, error: response.error };
				},
				"queuePanel.editFailed",
				t,
			);
		},
		[sidecarReady, t, tabRpc.queueEdit, queueStore],
	);

	const moveToLane = useCallback(
		(lane: QueueLane, id: string) => {
			if (!sidecarReady) return;
			void applyCrossLaneMove(queueStore, tabRpc, lane, id, t);
		},
		[sidecarReady, t, tabRpc, queueStore],
	);

	const clearLane = useCallback(
		(lane: QueueLane) => {
			if (!sidecarReady) return;
			void applyLaneMutation(
				queueStore,
				lane,
				() => [],
				async () => {
					const response = await tabRpc.queueClear(lane);
					return response.success
						? { success: true as const }
						: { success: false as const, error: response.error };
				},
				"queuePanel.clearFailed",
				t,
			);
		},
		[sidecarReady, t, tabRpc.queueClear, queueStore],
	);

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
					<div className="px-3 py-8 text-center text-omp-sm leading-relaxed text-(--omp-dim)">
						{t("queuePanel.empty")}
						<br />
						{t("queuePanel.emptyHint")}
					</div>
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
