/**
 * The composer's queue: one pill in the send cluster ("3 queued") that opens a popover (a bottom sheet on a phone)
 * with the messages waiting on the agent — steers (delivered at the next step of the running turn) under "After next
 * step", follow-ups (sent once the turn ends) under "After this turn". Nothing is added above, under or inside the
 * composer box while messages wait, so the transcript never moves when one queues (DR-8).
 *
 * Per row: lane icon, the text (a click shows all of it), **Steer now** as the primary action of a follow-up (a steer's
 * icon puts it after the turn), Edit (the composer field takes the message over: use-composer-queue-edit.ts) and ⋯ with
 * the lane switch, preview and remove. Stock cannot reorder a lane and re-queues an edited message at the end of its
 * lane: the row says so for a moment (`queue.moved`) and the pill reads "Edited · now last". The side panel's Queue tab
 * shares `useQueueActions`, the lane names and the heading (queue-lane.tsx).
 *
 * `ComposerQueueLive` is the composer's one polite live region: "Queued (n)", where an edit landed, and that a Stop
 * brought the queue back.
 */

import { CornerDownRight, Ellipsis, ListOrdered, ListPlus, Pencil, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { RpcQueuedMessage } from "../../../../shared/rpc-types";
import { useShellMode } from "../../../hooks/use-shell-mode";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { queueChipLabel } from "../../../lib/queue-chip";
import { useComposerStore } from "../../../stores/composer";
import { type QueueLane, useQueuedMessages, useQueueStore } from "../../../stores/queue";
import { useSettingsStore } from "../../../stores/settings";
import { Button, IconButton, MenuButton, Popover, Tooltip } from "../../common";
import { type QueueActions, useQueueActions } from "../../panels/use-queue-actions";
import { QueueImageTiles, QueueLaneHeading, queueRowName } from "./queue-lane";

const LANE_ICON: Record<QueueLane, typeof CornerDownRight> = {
	steering: CornerDownRight,
	followUp: ListPlus,
};

const QueueRow = memo(function QueueRow({
	item,
	lane,
	actions,
	onEdit,
	onEmptied,
	last,
}: {
	item: RpcQueuedMessage;
	lane: QueueLane;
	actions: QueueActions;
	/** The row's Edit took the message into the composer field. */
	onEdit: () => void;
	/** The row's action took the queue's last message away: the pill and the popover leave with it. */
	onEmptied: () => void;
	/** This is the queue's only message. */
	last: boolean;
}) {
	const t = useT();
	const beginEdit = useComposerStore(state => state.beginEditQueued);
	const [open, setOpen] = useState(false);
	const moved = useQueueStore(state => (state.moved?.id === item.id ? state.moved : null));
	const rowRef = useRef<HTMLLIElement>(null);
	// The re-queued row lands at the end of its lane: bring it into view so the position note is seen.
	useEffect(() => {
		if (moved) rowRef.current?.scrollIntoView?.({ block: "nearest" });
	}, [moved]);

	const imageCount = item.images?.length ?? 0;
	const label = queueChipLabel(item.text, imageCount);
	const name = queueRowName(item.text, imageCount);
	const Icon = LANE_ICON[lane];
	const other: QueueLane = lane === "steering" ? "followUp" : "steering";
	const OtherIcon = LANE_ICON[other];
	const steerNow = lane === "followUp";
	const notConnected = actions.ready ? undefined : t("common.notConnected");
	const toOther = () => {
		actions.moveToLane(lane, item.id);
	};
	const remove = () => {
		actions.remove(lane, item.id);
		if (last) onEmptied();
	};

	return (
		<li
			className={cx(
				"flex min-h-9 items-start gap-2 rounded-(--sc-radius-sm) py-1 pr-0.5 pl-2 transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover) [html[data-input=touch]_&]:min-h-11",
				moved && "bg-(--sc-accent-soft)",
			)}
			data-lane={lane}
			data-queue-row
			ref={rowRef}
		>
			<Tooltip content={t(`composerQueue.laneTip.${lane}`)} describe={false}>
				<span className="mt-1 inline-flex shrink-0 text-(--sc-text-muted)">
					<Icon aria-hidden className="size-(--sc-icon-sm)" />
					<span className="sr-only">{t(`composerQueue.lane.${lane}`)}</span>
				</span>
			</Tooltip>
			<div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
				<button
					aria-expanded={open}
					className={cx(
						"max-w-full min-w-0 rounded-(--sc-radius-xs) py-0.5 text-left text-sc-sm text-(--sc-text-secondary)",
						open ? "whitespace-pre-wrap break-words" : "truncate",
						item.text === "" && "italic text-(--sc-text-muted)",
					)}
					data-queue-row-text
					onClick={() => setOpen(value => !value)}
					title={open ? t("composerQueue.previewLess") : t("composerQueue.preview")}
					type="button"
				>
					{label || "…"}
				</button>
				{moved && (
					<span
						className="max-w-full truncate rounded-full bg-(--sc-accent-soft) px-2 text-sc-xs whitespace-nowrap text-(--sc-accent)"
						data-queue-moved-note
					>
						{t(moved.kind === "edit" ? "composerQueue.rowMoved" : "composerQueue.rowMovedLane", {
							lane: t(`composerQueue.lane.${moved.lane}`),
						})}
					</span>
				)}
			</div>
			{imageCount > 0 && <QueueImageTiles count={imageCount} images={item.images} />}
			<span className="flex shrink-0 items-center gap-2 [--hit-gap-x:8px] [--hit-gap-y:20px]">
				{steerNow ? (
					<Tooltip content={t("composerQueue.steerNowTip")} describe={false}>
						<Button
							aria-label={notConnected ?? t("composerQueue.steerNowAria", { text: name })}
							data-queue-primary
							disabled={!actions.ready}
							icon={<CornerDownRight aria-hidden />}
							onClick={toOther}
							size="sm"
							variant="secondary"
						>
							<span className="whitespace-nowrap">{t("composerQueue.steerNow")}</span>
						</Button>
					</Tooltip>
				) : (
					<IconButton
						data-queue-primary
						disabled={!actions.ready}
						icon={<ListPlus />}
						label={notConnected ?? t("composerQueue.laterAria", { text: name })}
						onClick={toOther}
						size="sm"
					/>
				)}
				{item.editable && (
					<IconButton
						disabled={!actions.ready}
						icon={<Pencil />}
						label={notConnected ?? t("composerQueue.editAria", { text: name })}
						onClick={() => {
							beginEdit({ id: item.id, lane, text: item.text });
							onEdit();
						}}
						size="sm"
					/>
				)}
				<MenuButton
					align="end"
					disabled={!actions.ready}
					icon={<Ellipsis />}
					items={[
						{
							id: "switch",
							label: steerNow ? t("composerQueue.steerNow") : t("composerQueue.lane.followUp"),
							icon: OtherIcon,
							onSelect: toOther,
						},
						{
							id: "preview",
							label: open ? t("composerQueue.previewLess") : t("composerQueue.preview"),
							onSelect: () => setOpen(value => !value),
						},
						{
							id: "remove",
							label: t("queuePanel.remove"),
							icon: Trash2,
							danger: true,
							separatorBefore: true,
							onSelect: remove,
						},
					]}
					label={notConnected ?? t("composerQueue.moreAria", { text: name })}
					size="sm"
				/>
			</span>
		</li>
	);
});

/** The count's place inside the localised "{count} queued", so only its words can fold away. */
const COUNT_MARK = "\u0000";

/**
 * The pill's text: "3 queued" with the words folding away in a narrow workspace (components.css, the toolbar's own
 * width ladder) so the pill never costs the toolbar its one row; a phone and a short-lived "Edited · now last" differ.
 */
function PillLabel({ count, edited, phone }: { count: number; edited: boolean; phone: boolean }) {
	const t = useT();
	if (phone) return <span className="tabular-nums">{count}</span>;
	if (edited)
		return (
			<span className="whitespace-nowrap">
				<span className="omp-queue-pill-word">{t("composerQueue.pillEdited")}</span>
				<span className="omp-queue-pill-count tabular-nums">{count}</span>
			</span>
		);
	const [before, after] = t("composerQueue.pill", { count: COUNT_MARK }).split(COUNT_MARK);
	return (
		<span className="whitespace-nowrap">
			{before && <span className="omp-queue-pill-word">{before}</span>}
			<span className="tabular-nums">{count}</span>
			{after && <span className="omp-queue-pill-word">{after}</span>}
		</span>
	);
}

/** "Steers arrive together · running tools are not interrupted": the policy of the agent's real settings (DR-18). */
function PolicyLine() {
	const t = useT();
	const steeringMode = useSettingsStore(state => state.steeringMode);
	const interruptMode = useSettingsStore(state => state.interruptMode);
	return (
		<p className="px-2 pb-1 text-sc-xs text-(--sc-text-subtle)" data-queue-policy>
			{t(steeringMode === "all" ? "composerQueue.policy.steerAll" : "composerQueue.policy.steerOne")}
			{" · "}
			{t(
				interruptMode === "wait" ? "composerQueue.policy.interruptWait" : "composerQueue.policy.interruptImmediate",
			)}
		</p>
	);
}

/**
 * The queue pill for the composer's send cluster and its popover. Renders nothing while nothing is queued or while a
 * queued message is being edited in the field (the field and Send are its editor then).
 * `onSettled`: the pill left with the last row; the composer takes focus back.
 */
export function ComposerQueuePill({ onSettled }: { onSettled: () => void }) {
	const t = useT();
	const { steering, followUp } = useQueuedMessages();
	const actions = useQueueActions();
	const editing = useComposerStore(state => state.editingQueued !== null);
	const edited = useQueueStore(state => state.moved?.kind === "edit");
	const phone = useShellMode() === "phone";
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	const total = steering.length + followUp.length;
	if (total === 0 || editing) return null;
	const close = () => setOpen(false);
	const emptied = () => {
		close();
		onSettled();
	};
	const clearAll = () => {
		if (steering.length > 0) actions.clearLane("steering");
		if (followUp.length > 0) actions.clearLane("followUp");
		emptied();
	};
	const lanes: { lane: QueueLane; items: RpcQueuedMessage[] }[] = [
		{ lane: "steering", items: steering },
		{ lane: "followUp", items: followUp },
	];

	return (
		<>
			<Button
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={t("composerQueue.pillOpen", { count: total })}
				className="omp-composer-queue-pill"
				data-queue-pill
				icon={<ListOrdered aria-hidden />}
				onClick={() => setOpen(value => !value)}
				// Mouse only: the field keeps its focus (a pointerdown handler would swallow the click in WebKit).
				onMouseDown={event => event.preventDefault()}
				ref={anchor}
				size="sm"
				variant={edited ? "secondary" : "ghost"}
			>
				<PillLabel count={total} edited={edited} phone={phone} />
			</Button>
			<Popover
				anchorRef={anchor}
				ariaLabel={t("composerQueue.listLabel")}
				className="max-w-[min(30rem,calc(100vw-1rem))]! p-1.5!"
				onClose={close}
				open={open}
				placement="top-end"
			>
				<div className="w-[min(28rem,calc(100vw-2rem))]" data-queue-popover>
					<div className="flex h-8 items-center gap-1.5 pr-0.5 pl-2 text-sc-xs text-(--sc-text-muted) [--hit-gap-x:8px] [--hit-gap-y:0px]">
						<span className="font-medium text-(--sc-text-secondary)">{t("composerQueue.listLabel")}</span>
						<span className="tabular-nums">{total}</span>
						<span className="min-w-1 flex-1" />
						<Button
							className="h-6 px-2 text-sc-xs"
							data-queue-clear
							disabled={!actions.ready}
							onClick={clearAll}
							size="sm"
							title={actions.ready ? undefined : t("common.notConnected")}
							variant="ghost"
						>
							{t("composerQueue.clearAll")}
						</Button>
					</div>
					<PolicyLine />
					<div className="max-h-72 overflow-y-auto overscroll-contain [--hit-gap-y:0px]" data-queue-list>
						{lanes.map(
							({ lane, items }) =>
								items.length > 0 && (
									<section aria-label={t(`composerQueue.lane.${lane}`)} key={lane}>
										<QueueLaneHeading count={items.length} lane={lane} />
										<ul>
											{items.map(item => (
												<QueueRow
													actions={actions}
													item={item}
													key={item.id}
													last={total === 1}
													lane={lane}
													onEdit={() => {
														close();
														onSettled();
													}}
													onEmptied={emptied}
												/>
											))}
										</ul>
									</section>
								),
						)}
					</div>
				</div>
			</Popover>
		</>
	);
}

/** Time a live message stays before the region clears (a repeat of the same text then announces again). */
const LIVE_CLEAR_MS = 5_000;
/** The queue hydrates a moment after the composer mounts: its first rows are not news. */
const LIVE_QUIET_MS = 800;

/**
 * The composer's polite live region (one per composer): "Queued (n)" when a message joins, where an edited or moved
 * message landed, and that a Stop brought the queue back into the composer (nothing sends until Resume).
 */
export function ComposerQueueLive() {
	const t = useT();
	const { steering, followUp } = useQueuedMessages();
	const moved = useQueueStore(state => state.moved);
	const held = useComposerStore(state => state.restoredQueue.length);
	const editingLane = useComposerStore(state => state.editingQueued?.lane ?? null);
	const [message, setMessage] = useState("");
	const total = steering.length + followUp.length;
	const seen = useRef({ total, moved, held, editingLane, since: Date.now() });
	useEffect(() => {
		const before = seen.current;
		seen.current = { total, moved, held, editingLane, since: before.since };
		if (Date.now() - before.since < LIVE_QUIET_MS) return;
		if (editingLane && !before.editingLane)
			setMessage(
				`${t("composerQueue.editBanner")}. ${t("composerQueue.editSaves", { lane: t(`composerQueue.lane.${editingLane}`) })}`,
			);
		else if (held > before.held) setMessage(t("composerQueue.livePaused", { count: held }));
		else if (moved && moved !== before.moved)
			setMessage(t("composerQueue.liveMoved", { lane: t(`composerQueue.lane.${moved.lane}`) }));
		else if (total > before.total) setMessage(t("composerQueue.liveQueued", { count: total }));
	}, [total, moved, held, editingLane, t]);
	useEffect(() => {
		if (!message) return;
		const timer = setTimeout(() => setMessage(""), LIVE_CLEAR_MS);
		return () => clearTimeout(timer);
	}, [message]);
	return (
		<div aria-live="polite" className="sr-only" data-composer-live role="status">
			{message}
		</div>
	);
}
