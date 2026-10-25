/**
 * The sessions this one's agent opened that are still at work, in the transcript: one line each with the child's title,
 * what it does now (its step, the question it waits on) and its clock, so the main view says what is happening without
 * opening the work board. The live work card shows them while the parent's agent waits on its children
 * (`ompdesk_session_result`); between the parent's turns the transcript's status row does. Same rows and live steps as
 * the board's "Child sessions" (`useOpenedChildren`, main's review push); nothing polls beyond the board's own ask.
 * The rows themselves (ChildrenAtWorkList.tsx) load only once a session has children at work: the phone's first screen
 * never shows them (scripts/check-main-bundle.ts).
 */
import { Suspense, useEffect, useMemo } from "react";
import { AGENT_CONTROL_TOOLS } from "../../../../shared/agent-control";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { lazyChunk } from "../../../lib/chunk-load";
import { ensureAgentReviewSubscription, useAgentReviewItems } from "../../../stores/agent-review";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import type { ToolEntry } from "../../../stores/tools";
import type { OpenedChildRow } from "../../layout/work-board/opened-children";

const ChildrenAtWorkList = lazyChunk(() =>
	import("./ChildrenAtWorkList").then(module => ({ default: module.ChildrenAtWorkList })),
);

/** A running call of the parent's agent that waits on the sessions it opened. */
export function waitsOnChildren(entry: ToolEntry | undefined): boolean {
	if (!entry || (entry.status !== "running" && entry.status !== "pending")) return false;
	return (
		entry.toolName === AGENT_CONTROL_TOOLS.result ||
		(entry.toolName === "write" && entry.args.path === `xd://${AGENT_CONTROL_TOOLS.result}`)
	);
}

/** This tab's children that run or wait on an answer: the ones still at work. */
export function useChildrenAtWork(): { tabId: string | null; rows: OpenedChildRow[] } {
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const { rows } = useOpenedChildren(tabId);
	const atWork = useMemo(
		() => rows.filter(row => !row.closed && (row.status === "running" || row.status === "waiting")),
		[rows],
	);
	return { tabId, rows: atWork };
}

/**
 * Whether this tab has a child at work, as one boolean: the transcript asks it on every render, and a component
 * subscribed to the whole tab list (`useChildrenAtWork`) re-renders the 50k-row transcript on every tab's status
 * change (nightly 39525167897: runtime.e2e's reading anchor moved 82 px, desktop.e2e's ⌘W missed its tab; both green
 * without 073a05d5c). Same rule as `openedChildRows`: a live tab this one opened that runs, compacts or waits, or a
 * child this window holds no tab of (a phone viewing the parent) that main's review list says runs or waits.
 */
export function useHasChildrenAtWork(): boolean {
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const review = useAgentReviewItems(tabId);
	useEffect(() => ensureAgentReviewSubscription(), []);
	return useTabsStore(state => {
		if (!tabId) return false;
		const parent = state.tabs.find(tab => tab.id === tabId);
		if (!parent) return false;
		const atWork = state.tabs.some(
			tab =>
				tab.id !== parent.id &&
				(tab.openedBy === parent.id ||
					(tab.openedBySession !== undefined && tab.openedBySession === parent.sessionPath)) &&
				(tab.status === "running" ||
					tab.compacting === true ||
					tab.awaitingInput !== undefined ||
					review.some(item => item.tabId === tab.id && item.waiting === true)),
		);
		return (
			atWork ||
			review.some(
				item =>
					(item.state === "running" || item.waiting === true) && !state.tabs.some(tab => tab.id === item.tabId),
			)
		);
	});
}

export function ChildrenAtWork({ className }: { className?: string }) {
	if (!useHasChildrenAtWork()) return null;
	return (
		<Suspense fallback={null}>
			<ChildrenAtWorkList className={className} />
		</Suspense>
	);
}
