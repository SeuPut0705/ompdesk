/**
 * Variant C: the queue is a compact pill in the toolbar ("3 queued") that opens a popover list with the row
 * actions. Nothing is added above, under or inside the box while messages wait, so the box never moves. Editing a
 * queued message takes over the composer (banner + "Edit queued" pill; Cancel puts the previous draft back), and
 * Stop pauses: the queued items come back as separate chips under a "Queue paused because you stopped · Resume"
 * banner, nothing sends until Resume.
 */

import { ListOrdered, Pause } from "lucide-react";
import { useRef, useState } from "react";
import { Badge, Button, Popover } from "../../../components/common";
import { ComposerShell } from "./frame";
import { initialOpen, type Store } from "./model";
import { LaneChip, LaneList, PausedBanner, RestoredChips, SendButton, StopButton, useIsPhone } from "./parts";
import { useP, useT } from "./strings";

function QueuePill({ store }: { store: Store }) {
	const t = useT();
	const p = useP();
	const phone = useIsPhone();
	const { s, act, list } = store;
	const [open, setOpen] = useState(initialOpen);
	const anchor = useRef<HTMLButtonElement>(null);
	const total = list.length;
	const close = () => setOpen(false);

	if (s.paused) {
		return (
			<span
				className="inline-flex h-(--sc-control-sm) items-center gap-1 rounded-(--sc-radius-sm) px-2 text-sc-sm text-(--sc-warning)"
				data-proto-pill
				data-paused
			>
				<Pause aria-hidden className="size-(--sc-icon-sm)" />
				<span className="whitespace-nowrap">
					{phone ? s.restored.length : p("paused.pill", { count: s.restored.length })}
				</span>
			</span>
		);
	}
	if (total === 0) return null;
	return (
		<>
			<Button
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={p("pill.open", { count: total })}
				className="omp-composer-chip"
				data-proto-pill
				icon={<ListOrdered aria-hidden />}
				onClick={() => setOpen(value => !value)}
				onPointerDown={event => event.preventDefault()}
				ref={anchor}
				size="sm"
				variant={s.moved ? "secondary" : "ghost"}
			>
				<span className="whitespace-nowrap tabular-nums">
					{phone ? total : s.moved ? p("moved.pill") : p("queue.summary", { count: total })}
				</span>
			</Button>
			<Popover
				anchorRef={anchor}
				ariaLabel={p("pill.title")}
				className="max-w-[min(30rem,calc(100vw-1rem))]! p-1.5!"
				onClose={close}
				open={open}
				placement="top-end"
			>
				<div className="w-[min(28rem,calc(100vw-2rem))]" data-proto-pop>
					<div className="flex h-8 items-center gap-1.5 pr-0.5 pl-2 text-sc-xs text-(--sc-text-muted) [--hit-gap-x:8px] [--hit-gap-y:0px]">
						<span className="font-medium text-(--sc-text-secondary)">{p("pill.title")}</span>
						<span className="tabular-nums">{total}</span>
						<span className="min-w-1 flex-1" />
						<Button
							className="h-6 px-2 text-sc-xs"
							data-proto-clear
							onClick={() => {
								act({ t: "clear" });
								close();
							}}
							size="sm"
							variant="ghost"
						>
							{t("composerQueue.clearAll")}
						</Button>
					</div>
					<p className="px-2 pb-1 text-sc-xs text-(--sc-text-subtle)">{p("policy.line")}</p>
					<ul className="max-h-72 overflow-y-auto overscroll-contain [--hit-gap-y:0px]" data-proto-list>
						<LaneList kind="pop" onEdit={close} store={store} />
					</ul>
				</div>
			</Popover>
		</>
	);
}

function EditBanner({ store }: { store: Store }) {
	const t = useT();
	const p = useP();
	const { s, act } = store;
	if (!s.editing) return null;
	return (
		<div
			className="flex h-9 items-center gap-2 rounded-t-(--sc-radius-xl) bg-(--sc-accent-soft) pr-1.5 pl-3 text-sc-sm text-(--sc-text) [--hit-gap-x:8px] [--hit-gap-y:0px]"
			data-proto-edit-banner
			role="status"
		>
			<Badge variant="accent">{p("editing.pill")}</Badge>
			<span className="min-w-0 flex-1 truncate text-sc-xs text-(--sc-text-muted)" title={p("editing.restore")}>
				{p("editing.saveMoves", { lane: p(`lane.${s.editing.lane}`) })}
			</span>
			<Button data-proto-edit-cancel onClick={() => act({ t: "editCancel" })} size="sm" variant="ghost">
				{t("queuePanel.cancelEdit")}
			</Button>
		</div>
	);
}

export function ComposerC({ store }: { store: Store }) {
	const { s } = store;
	return (
		<ComposerShell
			aboveField={
				<>
					<EditBanner store={store} />
					<PausedBanner store={store} />
					<RestoredChips store={store} />
				</>
			}
			cluster={
				<>
					{s.running && !s.editing && <LaneChip compactOnPhone store={store} />}
					{!s.editing && <QueuePill store={store} />}
					{s.running && <StopButton store={store} />}
					<SendButton fieldEdits store={store} />
				</>
			}
			fieldEdits
			store={store}
		/>
	);
}
