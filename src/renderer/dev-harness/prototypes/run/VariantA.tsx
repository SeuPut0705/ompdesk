/**
 * Variant A: the tray above the composer, repaired. One header line that folds the list past two items
 * ("5 queued ▸", expands in place under a fixed height cap), labelled lanes, "Steer now" as the row's primary
 * action with the opposite in the row menu, a per-row full-text preview, rows named by their text, Stop left /
 * Send right in fixed slots, and the send tooltip that names the chord for the other lane.
 */

import { ChevronRight, ListOrdered } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "../../../components/common";
import { cx } from "../../../lib/format";
import { ComposerShell } from "./frame";
import { initialOpen, type Store } from "./model";
import { LaneChip, LaneList, PausedBanner, QRow, RestoredChips, SendButton, StopButton } from "./parts";
import { useP, useT } from "./strings";

/** The list folds past this many items (spec: 2). `?fold=0` is the "one line always" form A′ used in the measurements. */
const FOLD_AFTER = Number(new URLSearchParams(location.search).get("fold") ?? 2);

const TRAY_CLASS =
	"omp-composer-queue omp-fade-up mx-3 -mb-(--sc-radius-xl) overflow-hidden rounded-t-(--sc-radius-lg) border border-b-0 border-(--sc-border-subtle) bg-(--sc-surface-1) pb-(--sc-radius-xl)";

function Tray({ store }: { store: Store }) {
	const t = useT();
	const p = useP();
	const { s, act, list } = store;
	const total = list.length;
	const folds = total > FOLD_AFTER;
	const [open, setOpen] = useState(initialOpen);
	const listId = useId();
	const showRows = !folds || open;
	// An edit or lane move re-queues at the end of a lane: open the list so the position note is seen.
	useEffect(() => {
		if (s.moved || s.editing) setOpen(true);
	}, [s.moved, s.editing]);
	if (total === 0) return null;
	const steer = list.filter(item => item.lane === "steer").length;
	return (
		<section aria-label={t("composerQueue.title")} className={TRAY_CLASS} data-proto-tray>
			<div className="flex h-8 items-center gap-1.5 pr-1 pl-3 text-sc-xs text-(--sc-text-muted) [--hit-gap-x:8px] [--hit-gap-y:0px]">
				{folds ? (
					<button
						aria-controls={listId}
						aria-expanded={open}
						className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left"
						data-proto-summary
						onClick={() => setOpen(value => !value)}
						title={open ? p("queue.hide") : p("queue.show")}
						type="button"
					>
						<ChevronRight
							aria-hidden
							className={cx("size-(--sc-icon-sm) shrink-0 transition-transform", open && "rotate-90")}
						/>
						<span className="shrink-0 font-medium text-(--sc-text-secondary)">
							{p("queue.summary", { count: total })}
						</span>
						<span className="min-w-0 truncate">{p("queue.summaryLanes", { steer, follow: total - steer })}</span>
					</button>
				) : (
					<>
						<ListOrdered aria-hidden className="size-(--sc-icon-sm) shrink-0" />
						<span className="truncate font-medium text-(--sc-text-secondary)">{t("composerQueue.title")}</span>
						<span className="shrink-0 tabular-nums">{total}</span>
						<span className="min-w-1 flex-1" />
					</>
				)}
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
			{showRows && (
				<ul
					className={cx(
						"overflow-y-auto overscroll-contain px-1 pb-1.5 [--hit-gap-y:0px]",
						s.editing ? "max-h-72" : "max-h-44",
					)}
					data-proto-list
					id={listId}
				>
					{folds ? (
						<LaneList kind="tray" store={store} />
					) : (
						list.map(item => <QRow item={item} key={item.id} kind="tray" store={store} />)
					)}
				</ul>
			)}
		</section>
	);
}

function PausedTray({ store }: { store: Store }) {
	if (!store.s.paused) return null;
	return (
		<section className={TRAY_CLASS} data-proto-tray>
			<PausedBanner store={store} />
		</section>
	);
}

export function ComposerA({ store }: { store: Store }) {
	const { s } = store;
	return (
		<ComposerShell
			aboveField={<RestoredChips store={store} />}
			cluster={
				<>
					{s.running && <LaneChip store={store} />}
					{s.running && <StopButton store={store} />}
					<SendButton fieldEdits={false} store={store} />
				</>
			}
			store={store}
			tray={
				<>
					<Tray store={store} />
					<PausedTray store={store} />
				</>
			}
		/>
	);
}
