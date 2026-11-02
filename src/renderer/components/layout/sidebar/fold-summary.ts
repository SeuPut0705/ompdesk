/**
 * What a folded sidebar header says about the sessions it hides: how many wait on the person, how many work, how many
 * finished unseen. Each hidden session counts once, by the token its own row shows (the row's rule decides it; this
 * module only ranks and adds). A session its agent opened is a row of its own (its family's), so its opener's "Child
 * waiting" is not counted again. A folded project, Chats, Archived or device section therefore never says something its
 * rows would not. The marks: `SidebarFoldSummary.tsx`.
 */
import { type AskKind, type AttentionKind, attentionClause, isAsk } from "../../../lib/attention";
import type { FamilyOpened } from "./SidebarSubagents";

/** The one thing a hidden row shows, if anything: its waiting token (by its prompt), its working arc, or its ✓. */
export type FoldSignal = AskKind | "running" | "done";

export interface FoldSummary {
	readonly waiting: number;
	readonly running: number;
	readonly done: number;
	/** The first waiting session's prompt: one is said by its row's word. */
	readonly ask: AskKind | null;
}

/** A session row's signal by the row's own order: its own prompt, then its run, then an unseen finish. */
export function sessionFoldSignal(row: {
	waiting: AttentionKind | undefined;
	running: boolean;
	done: boolean;
}): FoldSignal | null {
	if (isAsk(row.waiting)) return row.waiting;
	if (row.running) return "running";
	return row.done ? "done" : null;
}

/** A session its agent opened, as its family row says it: it waits or works, or says nothing here. */
export function childFoldSignal(child: Pick<FamilyOpened, "status" | "ask">): FoldSignal | null {
	if (child.status === "waiting") return child.ask ?? "question";
	return child.status === "running" ? "running" : null;
}

export function foldSummary(signals: Iterable<FoldSignal | null>): FoldSummary {
	const summary = { waiting: 0, running: 0, done: 0, ask: null as AskKind | null };
	for (const signal of signals)
		if (signal === "running" || signal === "done") summary[signal]++;
		else if (signal) {
			summary.waiting++;
			summary.ask ??= signal;
		}
	return summary;
}

/** "Needs approval · 2 running · 1 done" (the tooltip and screen-reader text), in the work board's words; "" when quiet. */
export function foldSummaryText(
	summary: FoldSummary,
	t: (key: string, params?: Record<string, string | number>) => string,
): string {
	return [
		summary.waiting > 0 ? attentionClause({ kind: summary.ask ?? "question", count: summary.waiting }, t) : null,
		summary.running > 0 ? t("workBoard.head.running", { count: summary.running }) : null,
		summary.done > 0 ? t("workBoard.doneFolded", { count: summary.done }) : null,
	]
		.filter(Boolean)
		.join(" · ");
}
