/**
 * MasterDetail — a list beside the chosen row's detail, and on a phone one pane at a time.
 *
 * - Desktop, tablet (portrait and landscape): two columns, the list on the left (a share of the width, 14–24rem)
 *   and the detail filling the rest. Nothing changes for an Electron window.
 * - Phone (`useShellMode() === "phone"`): a push navigation. The list fills the page; choosing a row (`open`)
 *   replaces it with the detail under a back bar, and the system back gesture (use-back-layer) does what the bar's
 *   button does, `onBack`. On a destination page (Settings, Agents) the bar moves up into the page's top bar
 *   (`[data-page-topbar-slot]`, AppShell's PageTopBar), so the page has one header row, not two.
 *
 * `open` is "a row is chosen": the caller keeps that state (a selection, a section) and clears it in `onBack`.
 * Pages that lay out their own list (Settings) use `useMasterDetail` and `MasterDetailBack` directly.
 */

import { ChevronLeft } from "lucide-react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../../hooks/use-back-layer";
import { useShellMode } from "../../hooks/use-shell-mode";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Button } from "./Button";

/** Which panes a master-detail shows: both on a desktop or tablet, one at a time on a phone. */
export function useMasterDetail(
	open: boolean,
	onBack: () => void,
): { stacked: boolean; showList: boolean; showDetail: boolean } {
	const stacked = useShellMode() === "phone";
	useBackLayer(stacked && open, onBack);
	return { stacked, showList: !stacked || !open, showDetail: !stacked || open };
}

/** The back button (and the detail's title) at the top of a phone's detail pane. */
export function MasterDetailBack({ onBack, label, title }: { onBack: () => void; label?: string; title?: string }) {
	const t = useT();
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	// Before paint: the page's top bar is mounted by now, so the bar never shows in the wrong place for a frame.
	useLayoutEffect(() => {
		setSlot(document.querySelector<HTMLElement>("[data-page-topbar-slot]"));
	}, []);
	const bar = (
		<>
			<Button data-master-detail-back icon={<ChevronLeft />} onClick={onBack} size="sm" variant="ghost">
				{label ?? t("masterDetail.back")}
			</Button>
			{title && (
				<span className="min-w-0 truncate text-sc-md font-semibold text-(--sc-text)" data-master-detail-title>
					{title}
				</span>
			)}
		</>
	);
	if (slot) return createPortal(bar, slot);
	return (
		<div
			className="flex shrink-0 items-center gap-1 border-b border-(--sc-divider) px-1 py-1"
			data-master-detail-back-bar
		>
			{bar}
		</div>
	);
}

export interface MasterDetailProps {
	/** Accessible name of the list. */
	label: string;
	list: ReactNode;
	detail: ReactNode;
	/** A row is chosen: on a phone the detail replaces the list. */
	open: boolean;
	/** Back from the detail on a phone: the caller clears its selection. */
	onBack: () => void;
	/** Text of the phone's back button (default "Back"). */
	backLabel?: string;
	className?: string;
}

export function MasterDetail({ label, list, detail, open, onBack, backLabel, className }: MasterDetailProps) {
	const { stacked, showList } = useMasterDetail(open, onBack);
	if (stacked) {
		return (
			<div
				className={cx("flex min-h-0 flex-1 flex-col", className)}
				data-master-detail="stacked"
				data-pane={showList ? "list" : "detail"}
			>
				{showList ? (
					<nav aria-label={label} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
						{list}
					</nav>
				) : (
					<>
						<MasterDetailBack label={backLabel} onBack={onBack} />
						<div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{detail}</div>
					</>
				)}
			</div>
		);
	}
	return (
		<div className={cx("flex min-h-0 flex-1", className)} data-master-detail="split">
			<nav
				aria-label={label}
				className="flex w-[clamp(14rem,40%,24rem)] shrink-0 flex-col overflow-y-auto border-r border-(--sc-divider) p-2"
			>
				{list}
			</nav>
			<div className="min-w-0 flex-1 overflow-y-auto">{detail}</div>
		</div>
	);
}
