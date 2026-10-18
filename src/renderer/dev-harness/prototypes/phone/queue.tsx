import { ChevronDown, CornerDownRight, Ellipsis, ListOrdered, ListPlus, Trash2, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { Button, IconButton } from "../../../components/common";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { type Lane, type QueueItem, useSession } from "./fake";
import { patchQueue } from "./logic";
import { keepFocus } from "./ProtoSheet";
import { useP } from "./strings";

export type QueueStyle = "menu" | "tap" | "chip";

const LANE_ICON = { steering: CornerDownRight, followUp: ListPlus } as const;

/** In-place edit of one queued message: Enter saves (Shift+Enter is a line), Cancel and Save reach 44 px. */
function QueueEditor({ item, onDone, extra }: { item: QueueItem; onDone: () => void; extra?: React.ReactNode }) {
	const t = useT();
	const { s, set, act } = useSession();
	const [draft, setDraft] = useState(item.text);
	const save = () => {
		act("queue-edit", draft);
		set({ queue: patchQueue(s, item.id, { text: draft }) });
		onDone();
	};
	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || isImeKeyEvent(event) || event.shiftKey) return;
		event.preventDefault();
		save();
	};
	return (
		<li className="flex flex-col gap-1.5 rounded-(--sc-radius-sm) px-2 py-1.5">
			<textarea
				aria-label={t("queuePanel.editInput")}
				autoFocus
				className="w-full resize-none rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-field) px-2 py-1.5 text-sc-lg text-(--sc-text) outline-none"
				onChange={event => setDraft(event.target.value)}
				onKeyDown={onKey}
				rows={2}
				value={draft}
			/>
			<div
				className="flex items-center justify-end gap-3"
				style={{ ["--hit-gap-x" as string]: "12px", ["--hit-gap-y" as string]: "8px" }}
			>
				{extra}
				<Button onClick={onDone} size="sm" variant="ghost">
					{t("common.cancel")}
				</Button>
				<Button onClick={save} size="sm" variant="primary">
					{t("common.save")}
				</Button>
			</div>
		</li>
	);
}

function LaneLabel({ lane }: { lane: Lane }) {
	const t = useT();
	const Icon = LANE_ICON[lane];
	return (
		<span className="inline-flex shrink-0 items-center gap-1 text-sc-xs text-(--sc-text-muted)">
			<Icon aria-hidden className="size-(--sc-icon-sm)" />
			{t(`queuePanel.lane.${lane}`)}
		</span>
	);
}

/** B: tap the row to edit (all actions inside), swipe left to remove, swipe right to switch lane. */
function TapRow({ item }: { item: QueueItem }) {
	const t = useT();
	const { s, set, act } = useSession();
	const [editing, setEditing] = useState(false);
	const [dx, setDx] = useState(0);
	const start = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);
	if (editing)
		return (
			<QueueEditor
				extra={
					<>
						<Button
							onClick={() => {
								act("queue-remove", item.id);
								set({ queue: s.queue.filter(entry => entry.id !== item.id) });
							}}
							size="sm"
							variant="ghost"
						>
							<Trash2 aria-hidden className="size-(--sc-icon-sm)" />
							{t("queuePanel.remove")}
						</Button>
						<Button
							onClick={() => {
								act("queue-move", item.id);
								set({
									queue: patchQueue(s, item.id, { lane: item.lane === "followUp" ? "steering" : "followUp" }),
								});
								setEditing(false);
							}}
							size="sm"
							variant="ghost"
						>
							{item.lane === "followUp" ? t("composerQueue.sendNow") : t("composerQueue.sendLater")}
						</Button>
					</>
				}
				item={item}
				onDone={() => setEditing(false)}
			/>
		);
	const down = (event: PointerEvent<HTMLElement>) => {
		start.current = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
	};
	const move = (event: PointerEvent<HTMLElement>) => {
		const origin = start.current;
		if (!origin || origin.id !== event.pointerId) return;
		const delta = event.clientX - origin.x;
		if (!origin.moved && (Math.abs(delta) < 10 || Math.abs(event.clientY - origin.y) > Math.abs(delta))) return;
		origin.moved = true;
		setDx(Math.max(-120, Math.min(120, delta)));
	};
	const up = () => {
		const origin = start.current;
		start.current = null;
		if (!origin?.moved) return;
		if (dx <= -72) {
			act("queue-remove", item.id);
			set({ queue: s.queue.filter(entry => entry.id !== item.id) });
		} else if (dx >= 72) {
			act("queue-move", item.id);
			set({ queue: patchQueue(s, item.id, { lane: item.lane === "followUp" ? "steering" : "followUp" }) });
		}
		setDx(0);
	};
	return (
		<li className="relative overflow-hidden rounded-(--sc-radius-sm)">
			<div aria-hidden className="absolute inset-0 flex items-center justify-between px-3 text-sc-sm">
				<span className="text-(--sc-text-muted)">
					{item.lane === "followUp" ? t("composerQueue.sendNow") : t("composerQueue.sendLater")}
				</span>
				<span className="text-(--sc-danger)">{t("queuePanel.remove")}</span>
			</div>
			<div
				className="relative flex min-h-11 cursor-pointer items-center gap-2 bg-(--sc-surface-1) pr-2 pl-2 touch-pan-y"
				data-queue-row=""
				onClick={() => !start.current?.moved && dx === 0 && setEditing(true)}
				onKeyDown={event => {
					if (event.key === "Enter" && !isImeKeyEvent(event)) setEditing(true);
				}}
				onPointerCancel={up}
				onPointerDown={down}
				onPointerMove={move}
				onPointerUp={up}
				role="button"
				style={{
					transform: dx ? `translateX(${dx}px)` : undefined,
					transition: dx ? "none" : "transform var(--sc-duration-fast)",
				}}
				tabIndex={0}
			>
				<LaneLabel lane={item.lane} />
				<span className="min-w-0 flex-1 truncate text-sc-md text-(--sc-text-secondary)">{item.text}</span>
			</div>
		</li>
	);
}

/** A: one ⋯ per row opens the actions sheet. C: lane chip (one tap), tap the text to edit, ✕ to remove. */
function ActionRow({
	item,
	style,
	onActions,
	editing,
	setEditing,
}: {
	item: QueueItem;
	style: "menu" | "chip";
	onActions: (id: number) => void;
	editing: boolean;
	setEditing: (editing: boolean) => void;
}) {
	const t = useT();
	const p = useP();
	const { s, set, act } = useSession();
	if (editing) return <QueueEditor item={item} onDone={() => setEditing(false)} />;
	const startEdit = () => setEditing(true);
	return (
		<li
			className="flex min-h-11 items-center gap-2 rounded-(--sc-radius-sm) pr-1 pl-2"
			data-queue-row=""
			style={{ ["--hit-gap-x" as string]: "16px", ["--hit-gap-y" as string]: "16px" }}
		>
			{style === "chip" ? (
				<Button
					{...keepFocus}
					aria-label={`${t(`queuePanel.lane.${item.lane}`)} · ${item.lane === "followUp" ? t("composerQueue.sendNow") : t("composerQueue.sendLater")}`}
					className="h-7 shrink-0"
					onClick={() => {
						act("queue-move", item.id);
						set({ queue: patchQueue(s, item.id, { lane: item.lane === "followUp" ? "steering" : "followUp" }) });
					}}
					size="sm"
					variant="secondary"
				>
					{t(`queuePanel.lane.${item.lane}`)}
				</Button>
			) : (
				<LaneLabel lane={item.lane} />
			)}
			<button
				aria-label={`${p("pp.queueEdit")}: ${item.text}`}
				className="min-h-11 min-w-0 flex-1 truncate text-left text-sc-md text-(--sc-text-secondary)"
				onClick={startEdit}
				type="button"
			>
				{item.text}
			</button>
			{style === "chip" ? (
				<IconButton
					icon={<X />}
					label={t("queuePanel.remove")}
					onClick={() => {
						act("queue-remove", item.id);
						set({ queue: s.queue.filter(entry => entry.id !== item.id) });
					}}
					size="md"
					tooltip={false}
				/>
			) : (
				<IconButton
					icon={<Ellipsis />}
					label={p("pp.messageActions")}
					onClick={() => onActions(item.id)}
					size="md"
					tooltip={false}
				/>
			)}
		</li>
	);
}

/** The queue tray: header, at most two rows, "+N more" for the rest. Same shell as production (`omp-composer-queue`). */
export function QueueTray({
	style,
	onActions,
	editId = null,
	setEditId = () => {},
}: {
	style: QueueStyle;
	onActions: (id: number) => void;
	editId?: number | null;
	setEditId?: (id: number | null) => void;
}) {
	const t = useT();
	const p = useP();
	const { s, set, act } = useSession();
	const [all, setAll] = useState(false);
	if (s.queue.length === 0) return null;
	const rows = all ? s.queue : s.queue.slice(0, 2);
	return (
		<section
			aria-label={t("composerQueue.title")}
			className="omp-composer-queue omp-fade-up mx-3 -mb-(--sc-radius-xl) overflow-hidden rounded-t-(--sc-radius-lg) border border-b-0 border-(--sc-border-subtle) bg-(--sc-surface-1) pb-(--sc-radius-xl)"
			data-queue-tray=""
			style={{ ["--hit-gap-x" as string]: "8px", ["--hit-gap-y" as string]: "0px" }}
		>
			<div className="flex h-8 items-center gap-1.5 pr-1 pl-3 text-sc-xs text-(--sc-text-muted)">
				{s.queue.length > 2 ? (
					<button
						aria-expanded={all}
						className="flex h-8 min-w-0 items-center gap-1.5"
						data-queue-toggle=""
						onClick={() => setAll(value => !value)}
						type="button"
					>
						<ListOrdered aria-hidden className="size-(--sc-icon-sm) shrink-0" />
						<span className="shrink-0 font-medium text-(--sc-text-secondary)">{t("composerQueue.title")}</span>
						<span className="shrink-0 tabular-nums">{s.queue.length}</span>
						<span className="shrink-0">
							{all ? p("pp.collapse") : `· ${p("pp.moreRows", { count: s.queue.length - 2 })}`}
						</span>
						<ChevronDown aria-hidden className={cx("size-(--sc-icon-sm) shrink-0", all && "rotate-180")} />
					</button>
				) : (
					<>
						<ListOrdered aria-hidden className="size-(--sc-icon-sm) shrink-0" />
						<span className="shrink-0 font-medium text-(--sc-text-secondary)">{t("composerQueue.title")}</span>
						<span className="shrink-0 tabular-nums">{s.queue.length}</span>
					</>
				)}
				<span className="min-w-1 flex-1" />
				{style === "tap" && <span className="truncate text-sc-xs">{p("pp.swipeHint")}</span>}
				<Button
					className="h-6 px-2 text-sc-xs"
					onClick={() => {
						act("queue-clear");
						set({ queue: [] });
					}}
					size="sm"
					variant="ghost"
				>
					{t("composerQueue.clearAll")}
				</Button>
			</div>
			<ul className="max-h-36 overflow-y-auto overscroll-contain px-1 pb-1">
				{rows.map(item =>
					style === "tap" ? (
						<TapRow item={item} key={item.id} />
					) : (
						<ActionRow
							editing={editId === item.id}
							item={item}
							key={item.id}
							onActions={onActions}
							setEditing={editing => setEditId(editing ? item.id : null)}
							style={style}
						/>
					),
				)}
			</ul>
		</section>
	);
}
