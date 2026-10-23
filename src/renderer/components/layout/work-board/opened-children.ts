/**
 * The sessions an agent opened (`ompdesk_session_open`) as children of the session that opened them, the way its
 * subagents are: one row each with the one status the sidebar's family reads (`openedChildStatus`), what it is doing,
 * how long, and where its branch stands. Pure; `hooks/use-opened-children.ts` feeds it from the stores the board,
 * the phone strip, the composer cue and the dock already read (tabs, the review queue main pushes, the closed list).
 */

import type { AgentReviewItem, ClosedChild } from "../../../../shared/agent-control";
import { isTabFailed } from "../../../lib/tab-signal";
import type { SessionTab } from "../../../stores/tabs";
import { type ChildStatus, openedChildStatus } from "../sidebar/sidebar-family";

export interface OpenedChildRow {
	/** The tab id, or the session file of one main closed after its work landed. */
	key: string;
	/** Null when this window holds no tab of it: one main closed (`closed`), or a paired host's child that opens there. */
	tabId: string | null;
	/** Main closed it after its work landed: a stored session, no child at work (never counted). */
	closed?: true;
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
	/** The question its open card asks (main's review item), when it waits on one. */
	question?: string;
	/** The paired device it runs on, by name; absent = this computer. */
	device?: string;
	/** That device's id, for a child this window holds no tab of: it opens there by its session file. */
	deviceId?: string;
}

export interface OpenedChildCounts {
	/** Every child still open (a tab here or on its host), finished ones included. */
	total: number;
	running: number;
	waiting: number;
	/** Finished and uneventful: the sidebar and the board fold these into their "n done" row. */
	done: number;
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
			isTabFailed(tab) ||
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
			// The tab list carries the turn's start with its running status; the review item only after its push.
			...((tab.runningSince ?? item?.runningSince) ? { since: tab.runningSince ?? item?.runningSince } : {}),
			...((item?.branch ?? tab.worktree?.branch) ? { branch: item?.branch ?? tab.worktree?.branch } : {}),
			...(item?.baseBranch !== undefined ? { base: item.baseBranch } : {}),
			...(unmerged ? { merge: "unmerged" as const } : tab.worktree && !item ? { merge: "merged" as const } : {}),
			...(item?.report ? { report: item.report } : {}),
			...(item?.question ? { question: item.question } : {}),
			...(tab.device ? { device: deviceName?.(tab.device) ?? tab.device } : {}),
		});
	}
	// Children this window holds no tab of: a phone viewing a session a desktop window holds lists only the tabs it
	// has, while the children are tabs of the window that opened them. Main's review list (pushed to every window
	// showing the parent) is then all this window knows of them.
	const known = new Set(tabs.map(tab => tab.id));
	for (const item of review.values()) {
		if (known.has(item.tabId)) continue;
		const unmerged =
			item.branch !== undefined && item.state !== "running" && (item.commitsAhead > 0 || item.uncommitted > 0);
		rows.push({
			key: item.tabId,
			// A paired host's list names that host's tabs: this window opens one by its session file where it runs.
			tabId: item.foreign ? null : item.tabId,
			...(item.sessionPath ? { sessionPath: item.sessionPath } : {}),
			...(item.device ? { device: deviceName?.(item.device) ?? item.device, deviceId: item.device } : {}),
			title: item.title,
			status: openedChildStatus({
				waiting: item.waiting === true,
				running: item.state === "running",
				finished: item.state !== "running",
				failed: item.failed === true,
				unmerged,
			}),
			...(item.step ? { step: item.step } : {}),
			...(item.runningSince ? { since: item.runningSince } : {}),
			...(item.branch ? { branch: item.branch } : {}),
			...(item.baseBranch !== undefined ? { base: item.baseBranch } : {}),
			...(unmerged ? { merge: "unmerged" as const } : {}),
			...(item.report ? { report: item.report } : {}),
			...(item.question ? { question: item.question } : {}),
		});
	}
	for (const child of closed) {
		if (child.openedBySession !== parent.sessionPath || shown.has(child.path)) continue;
		rows.push({
			key: child.path,
			tabId: null,
			closed: true,
			sessionPath: child.path,
			...(child.cwd ? { cwd: child.cwd } : {}),
			title: child.title,
			status: "done",
		});
	}
	return rows.toSorted((a, b) => ORDER[a.status ?? "none"] - ORDER[b.status ?? "none"]);
}

export function openedChildCounts(rows: readonly OpenedChildRow[]): OpenedChildCounts {
	const counts: OpenedChildCounts = { total: 0, running: 0, waiting: 0, done: 0 };
	for (const row of rows) {
		// Closed by main after their work landed: a stored session, no child at work. A paired host's child has no tab
		// here either and still counts.
		if (row.closed) continue;
		counts.total++;
		if (row.status === "running") counts.running++;
		else if (row.status === "waiting") counts.waiting++;
		else if (row.status === "done") counts.done++;
	}
	return counts;
}

/** A report or step as one line, cut at a word near this many characters (the row truncates it further). */
const ACTIVITY_CHARS = 120;

function oneLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	if (line.length <= ACTIVITY_CHARS) return line;
	const cut = line.slice(0, ACTIVITY_CHARS);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), ACTIVITY_CHARS / 2)).trimEnd()}…`;
}

/**
 * What a child is doing, in its own words, for the line under its title: a running one's current step (its open tool
 * call or last action, main's live push) or, before the first step, its progress report; a waiting one's open card's
 * question, else the question or blocker it reported; a finished one's report. Null when it has said nothing yet.
 */
export function childActivity(row: OpenedChildRow): string | null {
	const report = row.report?.text.trim() ? row.report : undefined;
	if (row.status === "running") return row.step ? oneLine(row.step) : report ? oneLine(report.text) : null;
	if (row.status === "waiting") {
		// An open card (a stock `ask`) is what it waits on now; else the question or blocker it reported.
		if (row.question?.trim()) return oneLine(row.question);
		return report && (report.kind === "question" || report.kind === "blocked") ? oneLine(report.text) : null;
	}
	return report ? oneLine(report.text) : null;
}
