import { useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "../../shared/ipc-types";
import { sessionListFeed } from "../stores/session-list";
import { type SessionTab, useTabsStore } from "../stores/tabs";

type ListedRow = Pick<SessionInfo, "path" | "id" | "title" | "autoTitle">;

/**
 * The row a tab's session has in the list its computer keeps (this computer's global list for a local tab, the
 * host's for a paired device's), for what a tab alone does not carry: the automatic title of a tab whose omp has not
 * reported it yet. Reads the feeds as they are (the sidebar holds them live); nothing here asks the host.
 */
export function useTabListRows(): (tab: SessionTab) => ListedRow | undefined {
	const devices = useTabsStore(state =>
		[...new Set(state.tabs.flatMap(tab => (tab.device ? [tab.device] : [])))].sort().join("\n"),
	);
	const feeds = useMemo(
		() => [
			{ device: "", feed: sessionListFeed("global") },
			...devices
				.split("\n")
				.filter(Boolean)
				.map(device => ({ device, feed: sessionListFeed("global", device) })),
		],
		[devices],
	);
	const [lists, setLists] = useState(
		() => new Map(feeds.map(({ device, feed }) => [device, feed.store.getState().sessions])),
	);
	useEffect(() => {
		const update = () => setLists(new Map(feeds.map(({ device, feed }) => [device, feed.store.getState().sessions])));
		update();
		const stops = feeds.map(({ feed }) => feed.store.subscribe(update));
		return () => {
			for (const stop of stops) stop();
		};
	}, [feeds]);
	return tab => {
		const rows = lists.get(tab.device ?? "");
		return rows?.find(
			row =>
				(tab.sessionPath !== undefined && row.path === tab.sessionPath) ||
				(tab.sessionId !== undefined && row.id === tab.sessionId),
		);
	};
}
