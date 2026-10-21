/**
 * The sessions this one's agent opened that are still at work, in the transcript: one line each with the child's title,
 * what it does now (its step, the question it waits on) and its clock, so the main view says what is happening without
 * opening the work board. The live work card shows them while the parent's agent waits on its children
 * (`ompdesk_session_result`); between the parent's turns the transcript's status row does. Same rows and live steps as
 * the board's "Child sessions" (`useOpenedChildren`, main's review push); nothing polls beyond the board's own ask.
 * The rows themselves (ChildrenAtWorkList.tsx) load only once a session has children at work: the phone's first screen
 * never shows them (scripts/check-main-bundle.ts).
 */
import { Suspense, useMemo } from "react";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { lazyChunk } from "../../../lib/chunk-load";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import type { ToolEntry } from "../../../stores/tools";
import type { OpenedChildRow } from "../../layout/work-board/opened-children";

const ChildrenAtWorkList = lazyChunk(() =>
	import("./ChildrenAtWorkList").then(module => ({ default: module.ChildrenAtWorkList })),
);

/** The control tool whose `wait` blocks the parent's turn on its children, called directly or as stock's `xd://` device. */
const CHILDREN_WAIT_TOOL = "ompdesk_session_result";

/** A running call of the parent's agent that waits on the sessions it opened. */
export function waitsOnChildren(entry: ToolEntry | undefined): boolean {
	if (!entry || (entry.status !== "running" && entry.status !== "pending")) return false;
	return (
		entry.toolName === CHILDREN_WAIT_TOOL ||
		(entry.toolName === "write" && entry.args.path === `xd://${CHILDREN_WAIT_TOOL}`)
	);
}

/** This tab's children that run or wait on an answer: the ones still at work. */
export function useChildrenAtWork(): { tabId: string | null; rows: OpenedChildRow[] } {
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const { rows } = useOpenedChildren(tabId);
	const atWork = useMemo(
		() => rows.filter(row => row.tabId !== null && (row.status === "running" || row.status === "waiting")),
		[rows],
	);
	return { tabId, rows: atWork };
}

export function ChildrenAtWork({ className }: { className?: string }) {
	const { rows } = useChildrenAtWork();
	if (rows.length === 0) return null;
	return (
		<Suspense fallback={null}>
			<ChildrenAtWorkList className={className} />
		</Suspense>
	);
}
