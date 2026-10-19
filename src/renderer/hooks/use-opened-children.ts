import { useEffect, useMemo } from "react";
import {
	type OpenedChildCounts,
	type OpenedChildRow,
	openedChildCounts,
	openedChildRows,
} from "../components/layout/work-board/opened-children";
import { ensureAgentReviewSubscription, useAgentReviewItems, useAgentReviewStore } from "../stores/agent-review";
import { ensureClosedChildren, useClosedChildrenStore } from "../stores/closed-children";
import { useRemoteStore } from "../stores/remote";
import { useTabsStore } from "../stores/tabs";

const NONE: readonly OpenedChildRow[] = [];

/**
 * The sessions `tabId`'s agent opened, as rows (`openedChildRows`). Reads the stores the sidebar already fills (tabs,
 * the review queue main pushes on every child's activity, the closed list); nothing polls.
 */
export function useOpenedChildren(tabId: string | null): {
	rows: readonly OpenedChildRow[];
	counts: OpenedChildCounts;
} {
	const tabs = useTabsStore(state => state.tabs);
	const review = useAgentReviewItems(tabId);
	const usage = useAgentReviewStore(state => state.usage);
	const closed = useClosedChildrenStore(state => state.rows);
	const hosts = useRemoteStore(state => state.state?.hosts);
	useEffect(() => {
		ensureAgentReviewSubscription();
		ensureClosedChildren();
	}, []);
	return useMemo(() => {
		const parent = tabId ? tabs.find(tab => tab.id === tabId) : undefined;
		const rows = parent
			? openedChildRows({
					parent,
					tabs,
					review: new Map(review.map(item => [item.tabId, item])),
					usage,
					closed,
					deviceName: id => hosts?.find(host => host.deviceId === id)?.name ?? id,
				})
			: NONE;
		return { rows, counts: openedChildCounts(rows) };
	}, [tabId, tabs, review, usage, closed, hosts]);
}
