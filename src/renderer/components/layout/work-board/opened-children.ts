/**
 * The sessions an agent opened (`ompdesk_session_open`) as children of the session that opened them, the way its
 * subagents are: one row each with the one status the sidebar's family reads (`openedChildStatus`), what it is doing,
 * how long, and where its branch stands. Pure; `hooks/use-opened-children.ts` feeds it from the stores the board,
 * the phone strip, the composer cue and the dock already read (tabs, the review queue main pushes, the closed list).
 */

import type { AgentReviewItem, ClosedChild } from "../../../../shared/agent-control";
import type { SessionTab } from "../../../stores/tabs";
import { type ChildStatus, openedChildStatus } from "../sidebar/sidebar-family";

export interface OpenedChildRow {
	/** The tab id, or the session file of one main closed after its work landed. */
	key: string;
	/** Null once the tab closed: the session is stored and opens as a pick. */
	tabId: string | null;
	sessionPath?: string;
	/** Where a stored one reopens. */
	cwd?: string;
	title: string;
	status: ChildStatus | null;
	/** What a running one is doing now (its open tool call). */
	step?: string;
	/** When its turn started (epoch ms), for the clock. */
	since?: number;
	branch?: string;
	base?: string | null;
	/** `unmerged`: commits or edits nothing merged; `merged`: its review is settled (merged, accepted); absent: no branch. */
	merge?: "unmerged" | "merged";
	/** Its last report to this session (`ompdesk_report`). */
	report?: { kind: string; text: string; at: number };
	/** The paired device it runs on, by name; absent = this computer. */
	device?: string;
}

export interface OpenedChildCounts {
	/** Every child with a tab, finished ones included. */
	total: number;
	running: number;
	waiting: number;
	/** Finished and uneventful: the sidebar folds these into its "n done" row. */
	done: number;
	/** Closed by main after their work landed (stored sessions). */
	closed: number;
}

const ORDER: Record<ChildStatus | "none", number> = { waiting: 0, problem: 1, running: 2, none: 3, done: 4 };

/**
 * The children of `parent`: tabs naming it as their opener (by tab id, or by session file after a relaunch gave every
 * tab a new id), then the stored sessions main closed for it. Waiting ones first, the folded "done" ones last.
 */
export function openedChildRows(input: {
	parent: Pick<SessionTab, "id" | "sessionPath">;
	tabs: readonly SessionTab[];
	review: ReadonlyMap<string, AgentReviewItem>;
	closed: readonly ClosedChild[];
	/** A paired device's display name (Settings › Devices) for a child that runs there. */
	deviceName?: (deviceId: string) => string;
}): OpenedChildRow[] {
	const { parent, tabs, review, closed, deviceName } = input;
	const rows: OpenedChildRow[] = [];
	const shown = new Set<string>();
	for (const tab of tabs) {
		const opened =
			tab.id !== parent.id &&
			(tab.openedBy === parent.id ||
				(tab.openedBySession !== undefined && tab.openedBySession === parent.sessionPath));
		if (!opened) continue;
		const item = review.get(tab.id);
		const failed =
			item?.failed === true ||
			tab.status === "error" ||
			tab.lastRun?.stopReason === "error" ||
			tab.lastRun?.stopReason === "aborted";
		const unmerged =
			item !== undefined &&
			item.branch !== undefined &&
			item.state !== "running" &&
			(item.commitsAhead > 0 || item.uncommitted > 0);
		const status = openedChildStatus({
			// A question or blocker its report raised waits on this session (never answered by itself).
			waiting: tab.awaitingInput !== undefined || item?.waiting === true,
			running: tab.status === "running" || tab.compacting === true,
			finished: tab.lastRun !== undefined,
			failed,
			unmerged,
		});
		if (tab.sessionPath) shown.add(tab.sessionPath);
		rows.push({
			key: tab.id,
			tabId: tab.id,
			...(tab.sessionPath ? { sessionPath: tab.sessionPath } : {}),
			title: tab.title || tab.task || "",
			status,
			...(item?.step ? { step: item.step } : {}),
			...(item?.runningSince ? { since: item.runningSince } : {}),
			...((item?.branch ?? tab.worktree?.branch) ? { branch: item?.branch ?? tab.worktree?.branch } : {}),
			...(item?.baseBranch !== undefined ? { base: item.baseBranch } : {}),
			...(unmerged ? { merge: "unmerged" as const } : tab.worktree && !item ? { merge: "merged" as const } : {}),
			...(item?.report ? { report: item.report } : {}),
			...(tab.device ? { device: deviceName?.(tab.device) ?? tab.device } : {}),
		});
	}
	for (const child of closed) {
		if (child.openedBySession !== parent.sessionPath || shown.has(child.path)) continue;
		rows.push({
			key: child.path,
			tabId: null,
			sessionPath: child.path,
			...(child.cwd ? { cwd: child.cwd } : {}),
			title: child.title,
			status: "done",
		});
	}
	return rows.toSorted((a, b) => ORDER[a.status ?? "none"] - ORDER[b.status ?? "none"]);
}

export function openedChildCounts(rows: readonly OpenedChildRow[]): OpenedChildCounts {
	const counts: OpenedChildCounts = { total: 0, running: 0, waiting: 0, done: 0, closed: 0 };
	for (const row of rows) {
		if (row.tabId === null) {
			counts.closed++;
			continue;
		}
		counts.total++;
		if (row.status === "running") counts.running++;
		else if (row.status === "waiting") counts.waiting++;
		else if (row.status === "done") counts.done++;
	}
	return counts;
}
