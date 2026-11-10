/**
 * The marks a folded sidebar header carries (`fold-summary.ts` counts them), each the rows' own: the waiting token, the
 * working arc, the ✓ of an unseen finish; nothing while all is quiet. A mark alone means one, several add their count
 * (the words say it either way: the tooltip and screen-reader text). Three marks fit beside a project's name in the
 * 248 px sidebar; with a count on each they cut "ompdesk" to "o…". It sits inside the header's fold button, so a tap on
 * them opens the section. An open header has none: its rows right below already show each token.
 */
import { AlertTriangle, Check } from "lucide-react";
import type { ReactElement } from "react";
import { useT } from "../../../lib/i18n";
import { WorkingArc } from "../../common";
import { type FoldSummary, foldSummaryText } from "./fold-summary";

export function SidebarFoldSummary({ summary }: { summary: FoldSummary }): ReactElement | null {
	const t = useT();
	const text = foldSummaryText(summary, t);
	if (!text) return null;
	return (
		<span
			className="flex shrink-0 items-center gap-1 text-sc-xs font-normal text-(--sc-text-muted)"
			data-fold-done={summary.done || undefined}
			data-fold-running={summary.running || undefined}
			data-fold-summary=""
			data-fold-waiting={summary.waiting || undefined}
			title={text}
		>
			{summary.waiting > 0 && (
				// The row's waiting badge (Badge `warning`), cut to its glyph and count.
				<span
					aria-hidden
					className="omp-sidebar-approval inline-flex h-4 items-center gap-0.5 rounded-full bg-(--sc-warning-soft) px-1 text-(--sc-warning-on-soft)"
				>
					<AlertTriangle className="size-3 shrink-0" />
					{summary.waiting > 1 && summary.waiting}
				</span>
			)}
			{summary.running > 0 && (
				<span aria-hidden className="inline-flex items-center gap-0.5">
					<WorkingArc state="turn" />
					{summary.running > 1 && summary.running}
				</span>
			)}
			{summary.done > 0 && (
				<span aria-hidden className="inline-flex items-center gap-0.5">
					<Check className="size-3 text-(--sc-success)" />
					{summary.done > 1 && summary.done}
				</span>
			)}
			<span className="sr-only">, {text}</span>
		</span>
	);
}
