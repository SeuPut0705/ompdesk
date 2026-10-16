/**
 * MasterDetail — a list beside the chosen row's detail, and on a phone one pane at a time.
 *
 * - Desktop, tablet (portrait and landscape): two columns, the list on the left (a share of the width, 14–24rem)
 *   and the detail filling the rest. Nothing changes for an Electron window.
 * - Phone (`useShellMode() === "phone"`): a push navigation. The list fills the page; choosing a row (`open`)
 *   replaces it with the detail under a back bar, and the system back gesture (use-back-layer) does what the bar's
 *   button does, `onBack`.
 *
 * `open` is "a row is chosen"; the caller keeps that state (a selection, a section) and clears it in `onBack`.
 * Pages that lay out their own list (Settings) use `useMasterDetail` and `MasterDetailBack` directly.
 */

import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
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

/** The back button at the top of a phone's detail pane. */
export function MasterDetailBack({ onBack, label }: { onBack: () => void; label?: string }) {
	const t = useT();
	return (
		<div className="shrink-0 border-b border-(--sc-divider) px-1 py-1" data-master-detail-back-bar>
			<Button data-master-detail-back icon={<ChevronLeft />} onClick={onBack} size="sm" variant="ghost">
				{label ?? t("masterDetail.back")}
			</Button>
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
