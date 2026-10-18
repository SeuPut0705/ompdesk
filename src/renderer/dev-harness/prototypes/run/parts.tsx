/**
 * Pieces the three run-state prototypes share: the field (IME guard, chords, Esc rules), the fixed Stop and Send
 * buttons, a queue row in three skins, restored chips and the paused banner. Real components, real tokens, real
 * `omp-composer-*` classes; only the state is fake (model.ts).
 */

import {
	ArrowUp,
	Brain,
	Check,
	ChevronDown,
	CornerDownRight,
	Cpu,
	Ellipsis,
	Image as ImageIcon,
	ListPlus,
	Pencil,
	Play,
	Plus,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton, TextArea, Tooltip } from "../../../components/common";
import { MenuButton } from "../../../components/common/ContextMenu";
import { useShellMode } from "../../../hooks/use-shell-mode";
import { cx } from "../../../lib/format";
import { isImeKeyEvent } from "../../../lib/ime";
import { composerFollowUpChord, formatShortcut, isComposerFollowUpKey } from "../../../lib/keymap";
import type { Lane, QItem, Store } from "./model";
import { type PT, useP, useT } from "./strings";

export const FOLLOW_CHORD = formatShortcut(composerFollowUpChord("mac"));
export const STEER_CHORD = formatShortcut("⌘↵");

export function short(text: string, max = 40): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function useIsPhone(): boolean {
	return useShellMode() === "phone";
}

/** What a row calls itself for assistive tech and for the image-only case. */
export function rowName(item: QItem, p: PT): string {
	return item.text || p("row.imageOnly", { count: item.images });
}

export function laneIcon(lane: Lane) {
	return lane === "steer" ? CornerDownRight : ListPlus;
}

// ── Field ────────────────────────────────────────────────────────────────────────────────────────────────

export function useFieldPlaceholder(store: Store, fieldEdits: boolean): string {
	const t = useT();
	const p = useP();
	const { s } = store;
	if (fieldEdits && s.editing) return p("editing.placeholder");
	if (s.running && s.ask === "question") return p("ask.question");
	if (s.running && s.ask === "approval") return p("ask.approval");
	if (s.running) return s.mode === "steer" ? t("input.placeholder.streaming") : t("input.placeholder.followUp");
	return t("input.placeholder.idle");
}

/** The composer field. `fieldEdits`: while a queued message is being edited the field holds its text (variant C). */
export function Field({ store, fieldEdits }: { store: Store; fieldEdits: boolean }) {
	const p = useP();
	const t = useT();
	const { s, act } = store;
	const phone = useIsPhone();
	const ref = useRef<HTMLTextAreaElement>(null);
	const [armed, setArmed] = useState(false);
	const armTimer = useRef<number | null>(null);
	const placeholder = useFieldPlaceholder(store, fieldEdits);
	const editingHere = fieldEdits && s.editing !== null;
	const value = editingHere ? (s.editing?.text ?? "") : s.draft;

	// biome-ignore lint/correctness/useExhaustiveDependencies: the field refits whenever its text changes
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		// Grow only once the text needs more than the rows give: a first character must not change the box by a sub-pixel.
		el.style.height = "";
		if (el.scrollHeight <= el.clientHeight + 1) return;
		const max = Number.parseFloat(getComputedStyle(el).lineHeight) * 8;
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
	}, [value]);

	useEffect(
		() => () => {
			if (armTimer.current !== null) window.clearTimeout(armTimer.current);
		},
		[],
	);

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "Escape") {
			if (editingHere) {
				event.preventDefault();
				act({ t: "editCancel" });
				return;
			}
			if (!s.running || s.stopPending) return;
			event.preventDefault();
			// DR-24: with a draft in the field the first Esc only arms the stop; the second one inside 1.5 s stops.
			if (s.draft === "" || armed) {
				setArmed(false);
				act({ t: "stop" });
				return;
			}
			setArmed(true);
			if (armTimer.current !== null) window.clearTimeout(armTimer.current);
			armTimer.current = window.setTimeout(() => setArmed(false), 1500);
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (isComposerFollowUpKey(event)) act({ t: "send", lane: "followUp" });
			else if (event.metaKey || event.ctrlKey) act({ t: "send", lane: "steer" });
			else act({ t: "send" });
		}
	};

	return (
		<div className="relative px-4 pt-3 pb-1">
			<textarea
				ref={ref}
				aria-label={t("input.ariaLabel")}
				className="omp-composer-input w-full resize-none bg-transparent text-sc-lg break-keep text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle) focus-visible:outline-none"
				data-composer-input
				enterKeyHint="send"
				onChange={event =>
					editingHere ? act({ t: "editText", v: event.target.value }) : act({ t: "draft", v: event.target.value })
				}
				onKeyDown={onKeyDown}
				placeholder={placeholder}
				rows={phone ? 1 : 2}
				value={value}
			/>
			{armed && (
				<span
					className="pointer-events-none absolute top-1 right-3 rounded-(--sc-radius-sm) bg-(--sc-elevated) px-1.5 text-sc-xs text-(--sc-text-muted)"
					data-esc-hint
					role="status"
				>
					{p("stop.escTwice")}
				</span>
			)}
		</div>
	);
}

// ── Toolbar controls shared by every variant ─────────────────────────────────────────────────────────────

export function ToolbarLeft() {
	const t = useT();
	const p = useP();
	const phone = useIsPhone();
	return (
		<>
			<IconButton icon={<Plus />} label={t("input.addMenu")} size="sm" />
			{phone && (
				<IconButton className="omp-composer-more" icon={<Ellipsis />} label={t("input.moreControls")} size="sm" />
			)}
			<Button
				className="omp-composer-chip"
				icon={<Brain aria-hidden />}
				size="sm"
				trailingIcon={<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />}
				variant="ghost"
			>
				<span className="omp-composer-control-label">{p("chip.think")}</span>
			</Button>
			<Button
				className="omp-composer-chip min-w-0 max-w-56"
				icon={<Cpu aria-hidden className="omp-composer-model-icon" />}
				size="sm"
				trailingIcon={<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />}
				variant="ghost"
			>
				<span className="omp-composer-model-label truncate">{p("chip.model")}</span>
			</Button>
		</>
	);
}

/** Stop, always the same slot (left of Send), same look. While a stop is in flight it is busy and inert (DR-13). */
export function StopButton({ store }: { store: Store }) {
	const t = useT();
	const p = useP();
	const { s, act } = store;
	return (
		<IconButton
			className="omp-composer-action"
			data-proto-stop
			disabled={s.stopPending}
			icon={<Square className="omp-composer-stop-glyph" fill="currentColor" />}
			label={s.stopPending ? p("stopping") : t("input.abort")}
			loading={s.stopPending}
			onClick={() => act({ t: "stop" })}
			onPointerDown={event => event.preventDefault()}
			shortcut="Esc"
			variant="secondary"
		/>
	);
}

export function sendTip(store: Store, p: PT, t: PT): string {
	const { s } = store;
	if (s.editing) return p("editing.saveMoves", { lane: p(`lane.${s.editing.lane}`) });
	if (!s.running) return t("input.send");
	if (s.mode === "steer") return `${p("send.steer")} · ${FOLLOW_CHORD} ${p("send.queueAfter")}`;
	return `${p("send.followUp")} · ${STEER_CHORD} ${p("send.steerKey")}`;
}

export function sendDisabled(store: Store, fieldEdits: boolean): boolean {
	const { s } = store;
	if (fieldEdits && s.editing) return s.editing.text.trim() === "";
	return s.draft.trim() === "" && s.draftImages === 0;
}

/** Send, always the right slot; a disabled disc while empty so nothing moves when a draft appears (DR-3). */
export function SendButton({ store, fieldEdits }: { store: Store; fieldEdits: boolean }) {
	const t = useT();
	const p = useP();
	const { s, act } = store;
	const saving = fieldEdits && s.editing !== null;
	const name = saving
		? p("edit.save")
		: !s.running
			? t("input.send")
			: s.mode === "steer"
				? p("send.steer")
				: p("send.followUp");
	return (
		<Tooltip content={sendTip(store, p, t)} side="top">
			<IconButton
				className="omp-composer-action"
				data-proto-send
				disabled={sendDisabled(store, fieldEdits)}
				icon={saving ? <Check strokeWidth={2.25} /> : <ArrowUp strokeWidth={2.25} />}
				label={name}
				onClick={() => act({ t: "send" })}
				onPointerDown={event => event.preventDefault()}
				tooltip={false}
				variant="primary"
			/>
		</Tooltip>
	);
}

/** The persistent text label of the lane Enter sends to, which is also the toggle (stock's send-mode chip). */
export function LaneChip({
	store,
	className,
	compactOnPhone = false,
}: {
	store: Store;
	className?: string;
	compactOnPhone?: boolean;
}) {
	const t = useT();
	const p = useP();
	const phone = useIsPhone();
	const { s, act } = store;
	const Icon = laneIcon(s.mode);
	const name = s.mode === "steer" ? t("input.steer") : t("input.followUp");
	return (
		<Tooltip content={p("lane.label.tip", { lane: name })} describe={false}>
			<Button
				aria-label={p("lane.label.tip", { lane: name })}
				className={cx("omp-composer-chip", className)}
				data-proto-lane
				icon={<Icon aria-hidden />}
				onClick={() => act({ t: "mode", v: s.mode === "steer" ? "followUp" : "steer" })}
				onPointerDown={event => event.preventDefault()}
				size="sm"
				variant="ghost"
			>
				<span className={cx("whitespace-nowrap", compactOnPhone && phone && "sr-only")}>{name}</span>
			</Button>
		</Tooltip>
	);
}

// ── Queue rows ───────────────────────────────────────────────────────────────────────────────────────────

function ImgTiles({ count }: { count: number }) {
	return (
		<span className="inline-flex shrink-0 items-center gap-0.5" data-queue-images>
			{Array.from({ length: Math.min(count, 3) }, (_, index) => (
				<span
					className="inline-flex size-5 items-center justify-center rounded-(--sc-radius-xs) border border-(--sc-border-subtle) bg-(--sc-surface-2) text-(--sc-text-muted)"
					key={index}
				>
					<ImageIcon aria-hidden className="size-3" />
				</span>
			))}
			{count > 3 && <span className="text-sc-xs tabular-nums text-(--sc-text-muted)">+{count - 3}</span>}
		</span>
	);
}

export type RowKind = "tray" | "ghost" | "pop";

/** One queued message in the skin of its variant: tray (A), ghost (B), popover (C). */
export function QRow({ item, store, kind, onEdit }: { item: QItem; store: Store; kind: RowKind; onEdit?: () => void }) {
	const t = useT();
	const p = useP();
	const { s, act } = store;
	const [open, setOpen] = useState(false);
	const name = short(rowName(item, p));
	const lane = p(`lane.${item.lane}`);
	const flash = s.moved?.id === item.id;
	const rowRef = useRef<HTMLLIElement>(null);
	// The re-queued row lands at the end of its lane: bring it into view so the position note is seen.
	useEffect(() => {
		if (flash) rowRef.current?.scrollIntoView({ block: "nearest" });
	}, [flash]);
	const editingHere = kind !== "pop" && s.editing?.id === item.id;
	const Icon = laneIcon(item.lane);
	const other: Lane = item.lane === "steer" ? "followUp" : "steer";
	const toOther = () => act({ t: "toLane", id: item.id, lane: other });
	const startEdit = () => {
		act({ t: "editStart", id: item.id });
		onEdit?.();
	};

	if (editingHere && s.editing) {
		return (
			<li className="flex flex-col gap-1.5 px-2 py-1.5" data-proto-row data-editing>
				<TextArea
					aria-label={t("queuePanel.editInput")}
					autoFocus
					autoGrow
					className="max-h-40 py-1.5 text-sc-sm"
					onChange={event => act({ t: "editText", v: event.target.value })}
					onKeyDown={event => {
						if (isImeKeyEvent(event)) return;
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							act({ t: "editCancel" });
						} else if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							act({ t: "editSave" });
						}
					}}
					rows={1}
					value={s.editing.text}
				/>
				<div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 [--hit-gap-x:8px] [--hit-gap-y:4px]">
					<span className="mr-auto min-w-0 text-sc-xs text-(--sc-text-subtle)" data-edit-position-note>
						{p("edit.hint", { lane })}
					</span>
					<Button onClick={() => act({ t: "editCancel" })} size="sm" variant="ghost">
						{t("queuePanel.cancelEdit")}
					</Button>
					<Button
						disabled={s.editing.text.trim() === ""}
						onClick={() => act({ t: "editSave" })}
						size="sm"
						variant="secondary"
					>
						{p("edit.save")}
					</Button>
				</div>
			</li>
		);
	}

	const text = (
		<button
			aria-expanded={open}
			className={cx(
				"max-w-full min-w-0 rounded-(--sc-radius-xs) text-left text-sc-sm text-(--sc-text-secondary)",
				open ? "whitespace-pre-wrap break-words" : "truncate",
				!item.text && "italic text-(--sc-text-muted)",
			)}
			data-proto-row-text
			onClick={() => setOpen(value => !value)}
			title={open ? p("row.previewLess") : p("row.preview")}
			type="button"
		>
			{rowName(item, p)}
		</button>
	);

	const note = flash && (
		<span
			className="max-w-full truncate rounded-full bg-(--sc-accent-soft) px-2 text-sc-xs whitespace-nowrap text-(--sc-accent)"
			data-moved-note
		>
			{p(s.moved?.kind === "edit" ? "moved.note" : "moved.noteLane", { lane })}
		</span>
	);

	const menu = (
		<MenuButton
			align="end"
			icon={<Ellipsis />}
			items={[
				{
					id: "switch",
					label: item.lane === "steer" ? p("row.queueLater") : p("row.steerNow"),
					icon: laneIcon(other),
					onSelect: toOther,
				},
				{
					id: "preview",
					label: open ? p("row.previewLess") : p("row.preview"),
					onSelect: () => setOpen(value => !value),
				},
				{
					id: "remove",
					label: t("queuePanel.remove"),
					icon: Trash2,
					danger: true,
					separatorBefore: true,
					onSelect: () => act({ t: "remove", id: item.id }),
				},
			]}
			label={p("row.more", { text: name })}
			size="sm"
		/>
	);

	if (kind === "ghost") {
		return (
			<li
				ref={rowRef}
				className={cx(
					"flex min-h-8 items-start gap-2 rounded-(--sc-radius-sm) py-1 pr-0.5 pl-1.5 text-(--sc-text-muted) [html[data-input=touch]_&]:min-h-10",
					flash && "bg-(--sc-accent-soft)",
				)}
				data-lane={item.lane}
				data-proto-row
			>
				<Tooltip content={lane} describe={false}>
					<span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-sc-xs text-(--sc-text-subtle)">
						<Icon aria-hidden className="size-(--sc-icon-sm)" />
						<span className="max-w-20 truncate">
							{item.lane === "steer" ? t("input.steer") : t("input.followUp")}
						</span>
						<span className="sr-only">{lane}</span>
					</span>
				</Tooltip>
				<div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
					{text}
					{note}
				</div>
				{item.images > 0 && <ImgTiles count={item.images} />}
				<span className="flex shrink-0 items-center gap-2 [--hit-gap-x:8px] [--hit-gap-y:16px]">
					<IconButton icon={<Pencil />} label={p("row.edit.aria", { text: name })} onClick={startEdit} size="sm" />
					<IconButton
						data-proto-primary
						icon={item.lane === "steer" ? <ListPlus /> : <CornerDownRight />}
						label={
							item.lane === "steer"
								? p("row.queueLater.aria", { text: name })
								: p("row.steerNow.aria", { text: name })
						}
						onClick={toOther}
						size="sm"
						tooltipSide="top"
					/>
					<IconButton
						className="hover:text-(--sc-danger)"
						icon={<X />}
						label={p("row.remove.aria", { text: name })}
						onClick={() => act({ t: "remove", id: item.id })}
						size="sm"
					/>
				</span>
			</li>
		);
	}

	const primarySteer = item.lane === "followUp";
	return (
		<li
			ref={rowRef}
			className={cx(
				"flex min-h-9 items-start gap-2 rounded-(--sc-radius-sm) py-1 pr-0.5 pl-2 hover:bg-(--sc-hover) [html[data-input=touch]_&]:min-h-11",
				flash && "bg-(--sc-accent-soft)",
			)}
			data-lane={item.lane}
			data-proto-row
		>
			<span className="mt-1 inline-flex shrink-0 text-(--sc-text-muted)">
				<Icon aria-hidden className="size-(--sc-icon-sm)" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
				{text}
				{note}
			</div>
			{item.images > 0 && <ImgTiles count={item.images} />}
			<span className="flex shrink-0 items-center gap-2 [--hit-gap-x:8px] [--hit-gap-y:20px]">
				{primarySteer ? (
					<Tooltip content={p("row.steerNow.tip")} describe={false}>
						<Button
							aria-label={p("row.steerNow.aria", { text: name })}
							data-proto-primary
							icon={<CornerDownRight aria-hidden />}
							onClick={toOther}
							size="sm"
							variant="secondary"
						>
							<span className="whitespace-nowrap">{p("row.steerNow")}</span>
						</Button>
					</Tooltip>
				) : (
					<IconButton
						data-proto-primary
						icon={<ListPlus />}
						label={p("row.queueLater.aria", { text: name })}
						onClick={toOther}
						shortcut={undefined}
						size="sm"
					/>
				)}
				<IconButton icon={<Pencil />} label={p("row.edit.aria", { text: name })} onClick={startEdit} size="sm" />
				{menu}
			</span>
		</li>
	);
}

/** Lane heading inside an expanded list. */
export function LaneHead({ lane, count }: { lane: Lane; count: number }) {
	const p = useP();
	return (
		<li
			aria-hidden="true"
			className="flex h-5 items-center gap-1.5 px-2 text-sc-xs font-medium text-(--sc-text-subtle)"
			data-lane-head={lane}
			title={p(`lane.${lane}.tip`)}
		>
			<span>{p(`lane.${lane}`)}</span>
			<span className="tabular-nums">{count}</span>
			<span className="min-w-0 truncate font-normal">· {p(`lane.${lane}.sub`)}</span>
		</li>
	);
}

/** Rows grouped by lane with labelled headings; `limit` caps how many rows show (the rest scroll or fold). */
export function LaneList({ store, kind, onEdit }: { store: Store; kind: RowKind; onEdit?: () => void }) {
	const { list } = store;
	const steer = list.filter(item => item.lane === "steer");
	const follow = list.filter(item => item.lane === "followUp");
	return (
		<>
			{steer.length > 0 && <LaneHead count={steer.length} lane="steer" />}
			{steer.map(item => (
				<QRow item={item} key={item.id} kind={kind} onEdit={onEdit} store={store} />
			))}
			{follow.length > 0 && <LaneHead count={follow.length} lane="followUp" />}
			{follow.map(item => (
				<QRow item={item} key={item.id} kind={kind} onEdit={onEdit} store={store} />
			))}
		</>
	);
}

// ── Stop outcome: restored chips and the paused banner ───────────────────────────────────────────────────

export function RestoredChips({ store }: { store: Store }) {
	const p = useP();
	const { s, act } = store;
	if (s.restored.length === 0) return null;
	return (
		<ul
			aria-label={p("paused.chips")}
			className="flex h-9 shrink-0 flex-nowrap items-center gap-2 overflow-x-auto px-3 pt-2 [--hit-gap-x:8px] [--hit-gap-y:4px] [scrollbar-width:none]"
			data-proto-restored
		>
			{s.restored.map(item => {
				const Icon = laneIcon(item.lane);
				return (
					<li
						className="inline-flex h-7 max-w-[70%] shrink-0 items-center gap-1.5 rounded-full border border-(--sc-border-subtle) bg-(--sc-surface-2) pr-0.5 pl-2.5 text-sc-xs text-(--sc-text-secondary)"
						data-proto-chip
						key={item.id}
					>
						<Icon aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
						<span className="min-w-0 truncate" title={item.text}>
							{item.text || p("row.imageOnly", { count: item.images })}
						</span>
						<IconButton
							className="size-6 rounded-full"
							icon={<X />}
							label={p("paused.chip.remove", { text: short(rowName(item, p)) })}
							onClick={() => act({ t: "removeRestored", id: item.id })}
							size="sm"
						/>
					</li>
				);
			})}
		</ul>
	);
}

export function PausedBanner({ store, className }: { store: Store; className?: string }) {
	const p = useP();
	const t = useT();
	const { s, act } = store;
	if (!s.paused) return null;
	return (
		<div
			className={cx(
				"flex min-h-9 items-center gap-2 py-0.5 pr-1.5 pl-3 text-sc-sm text-(--sc-text-secondary) [--hit-gap-x:8px] [--hit-gap-y:0px]",
				className,
			)}
			data-proto-paused
			role="status"
		>
			<span className="min-w-0 flex-1 text-sc-sm leading-tight">{p("paused.banner")}</span>
			<Tooltip content={p("paused.resume.tip")} describe={false}>
				<Button
					data-proto-resume
					icon={<Play aria-hidden />}
					onClick={() => act({ t: "resume" })}
					size="sm"
					variant="secondary"
				>
					{p("paused.resume")}
				</Button>
			</Tooltip>
			<Button data-proto-discard onClick={() => act({ t: "discard" })} size="sm" variant="ghost">
				{p("paused.discard")}
			</Button>
			<span className="sr-only">{t("composerQueue.title")}</span>
		</div>
	);
}

export function LiveRegion({ store }: { store: Store }) {
	const p = useP();
	const { live } = store.s;
	let message = "";
	if (live) {
		const params = { ...(live.params ?? {}) };
		if (typeof params.lane === "string" && params.lane.startsWith("lane.")) params.lane = p(params.lane);
		message = p(live.key, params);
	}
	return (
		<div aria-live="polite" className="sr-only" data-proto-live role="status">
			{message}
		</div>
	);
}
