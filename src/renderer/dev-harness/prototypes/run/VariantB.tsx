/**
 * Variant B: the queue lives inside the composer box, under the field, as stacked ghost rows (the Codex /
 * Claude Code way). Two rows show, the rest fold under "+N more"; Send is a split button whose label always names
 * the lane Enter sends to (primary = that lane, caret = send once to either lane or change what Enter does).
 */

import { ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, IconButton, Tooltip } from "../../../components/common";
import { MenuButton } from "../../../components/common/ContextMenu";
import { cx } from "../../../lib/format";
import { ComposerShell } from "./frame";
import { initialOpen, type Store } from "./model";
import { FOLLOW_CHORD, LaneList, PausedBanner, QRow, RestoredChips, StopButton, sendDisabled, sendTip } from "./parts";
import { useP, useT } from "./strings";

const VISIBLE = 2;

function GhostRows({ store }: { store: Store }) {
	const t = useT();
	const p = useP();
	const { s, act, list } = store;
	const [open, setOpen] = useState(initialOpen);
	useEffect(() => {
		if (s.moved || s.editing) setOpen(true);
	}, [s.moved, s.editing]);
	if (list.length === 0) return null;
	const folds = list.length > VISIBLE;
	return (
		<div className="!order-3 px-2 pb-1" data-proto-ghost>
			<ul
				aria-label={t("composerQueue.title")}
				className={cx(
					"overflow-y-auto overscroll-contain [--hit-gap-y:0px]",
					open && folds && (s.editing ? "max-h-72" : "max-h-44"),
				)}
				data-proto-list
			>
				{folds && open ? (
					<LaneList kind="ghost" store={store} />
				) : (
					list.slice(0, VISIBLE).map(item => <QRow item={item} key={item.id} kind="ghost" store={store} />)
				)}
			</ul>
			{folds && (
				<div className="flex h-7 items-center gap-2 pl-1.5 text-sc-xs text-(--sc-text-muted) [--hit-gap-x:8px] [--hit-gap-y:0px]">
					<button
						aria-expanded={open}
						className="flex h-7 min-w-0 flex-1 items-center gap-1 text-left"
						data-proto-summary
						onClick={() => setOpen(value => !value)}
						type="button"
					>
						<ChevronRight
							aria-hidden
							className={cx("size-(--sc-icon-sm) shrink-0 transition-transform", open && "rotate-90")}
						/>
						<span className="truncate">
							{open ? p("queue.hide") : p("queue.more", { count: list.length - VISIBLE })}
						</span>
					</button>
					<Button
						className="h-6 px-2 text-sc-xs"
						data-proto-clear
						onClick={() => act({ t: "clear" })}
						size="sm"
						variant="ghost"
					>
						{t("composerQueue.clearAll")}
					</Button>
				</div>
			)}
		</div>
	);
}

function SplitSend({ store }: { store: Store }) {
	const t = useT();
	const p = useP();
	const { s, act } = store;
	const disabled = sendDisabled(store, false);
	const label = s.mode === "steer" ? t("input.steer") : t("input.followUp");
	if (!s.running) {
		return (
			<Tooltip content={t("input.send")} side="top">
				<IconButton
					className="omp-composer-action"
					data-proto-send
					disabled={disabled}
					icon={<ArrowUp strokeWidth={2.25} />}
					label={t("input.send")}
					onClick={() => act({ t: "send" })}
					onPointerDown={event => event.preventDefault()}
					tooltip={false}
					variant="primary"
				/>
			</Tooltip>
		);
	}
	return (
		<span className="inline-flex items-center" data-proto-split>
			<Tooltip content={sendTip(store, p, t)} side="top">
				<Button
					aria-label={sendTip(store, p, t)}
					className="omp-composer-action rounded-r-none! pr-2.5!"
					data-proto-send
					disabled={disabled}
					icon={<ArrowUp strokeWidth={2.25} />}
					onClick={() => act({ t: "send" })}
					onPointerDown={event => event.preventDefault()}
					variant="primary"
				>
					<span className="whitespace-nowrap" data-proto-lane-label>
						{label}
					</span>
				</Button>
			</Tooltip>
			<MenuButton
				align="end"
				className="rounded-l-none! border-l! border-l-(--sc-accent-fg)/30!"
				icon={<ChevronDown />}
				items={[
					{
						id: "steer",
						label: p("send.steerItem"),
						shortcut: "⌘↵",
						disabled,
						onSelect: () => act({ t: "send", lane: "steer" }),
					},
					{
						id: "followUp",
						label: p("send.followItem"),
						shortcut: FOLLOW_CHORD,
						disabled,
						onSelect: () => act({ t: "send", lane: "followUp" }),
					},
					{
						id: "enter-steer",
						label: p("enter.hint", { chord: FOLLOW_CHORD }),
						checked: s.mode === "steer",
						separatorBefore: true,
						onSelect: () => act({ t: "mode", v: "steer" }),
					},
					{
						id: "enter-follow",
						label: p("enter.hintFollow", { chord: "⌘↵" }),
						checked: s.mode === "followUp",
						onSelect: () => act({ t: "mode", v: "followUp" }),
					},
				]}
				label={p("send.menu")}
				size="md"
				variant="primary"
			/>
		</span>
	);
}

export function ComposerB({ store }: { store: Store }) {
	const { s } = store;
	return (
		<ComposerShell
			aboveField={<RestoredChips store={store} />}
			belowField={
				<>
					<GhostRows store={store} />
					<PausedBanner className="!order-3" store={store} />
				</>
			}
			cluster={
				<>
					{s.running && <StopButton store={store} />}
					<SplitSend store={store} />
				</>
			}
			store={store}
		/>
	);
}
