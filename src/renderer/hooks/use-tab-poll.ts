import { useCallback, useEffect, useSyncExternalStore } from "react";
import { type TabRpc, useTabRpc } from "../lib/tab-rpc";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";

/**
 * Starts polling one tab: read through `rpc()` (the route of a surface still showing it, undefined once none
 * is) and publish each read as an update of the shown value (returning the current one changes nothing).
 * Returns `read` (one read now, outside the schedule) and `stop`.
 */
export type TabPollStart<T> = (
	rpc: () => TabRpc | undefined,
	publish: (update: (current: T) => T) => void,
) => { read: () => void; stop: () => void };

interface Feed<T> {
	value: T;
	listeners: Set<() => void>;
	/** The surfaces polling now, each with its own route to the tab; the feed polls while any is. */
	readers: Set<{ rpc: TabRpc }>;
	poller: { read: () => void; stop: () => void } | null;
}

/**
 * One value per tab that several surfaces show (the sidebar and the work board, the dock and the board):
 * one poll per tab however many of them are mounted, started by the first and stopped with the last.
 */
export class TabPoll<T> {
	readonly #feeds = new Map<string, Feed<T>>();

	constructor(
		readonly initial: T,
		readonly start: TabPollStart<T>,
	) {}

	feed(key: string): Feed<T> {
		let feed = this.#feeds.get(key);
		if (!feed) {
			feed = { value: this.initial, listeners: new Set(), readers: new Set(), poller: null };
			this.#feeds.set(key, feed);
		}
		return feed;
	}

	value(key: string): T {
		const feed = this.#feeds.get(key);
		return feed ? feed.value : this.initial;
	}

	/** Show `update` of a tab's value on every surface showing it: a read made outside the poll. Nothing shows it: dropped. */
	publish(key: string, update: (current: T) => T): void {
		const feed = this.#feeds.get(key);
		if (feed) show(feed, update);
	}

	/** Forget a feed nothing shows or polls any more: the next surface starts from its own first read. */
	release(key: string, feed: Feed<T>): void {
		if (feed.listeners.size === 0 && feed.readers.size === 0 && this.#feeds.get(key) === feed)
			this.#feeds.delete(key);
	}
}

function show<T>(feed: Feed<T>, update: (current: T) => T): void {
	const value = update(feed.value);
	if (Object.is(value, feed.value)) return;
	feed.value = value;
	for (const listener of feed.listeners) listener();
}

/** The tab a surface's polls follow: the pane's tab, or outside a pane the focused one. */
export function useTabPollKey(): string {
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	return runtimeTabId ?? activeTabId ?? "";
}

/**
 * `select` of this tab's value of `poll`: the pane's tab, or outside a pane the focused one (whose rpc the
 * window's route reaches), so the sidebar and the focused pane share one feed. Polls while `active`. A surface
 * re-renders only when what it selects changes. `scope` names what else the value belongs to (a session the tab
 * can switch in place): another scope is another feed, read afresh, and the old feed's poller stops, so a reply
 * for the old scope can never land in the new one.
 */
export function useTabPoll<T, S>(poll: TabPoll<T>, active: boolean, select: (value: T) => S, scope = ""): S {
	const rpc = useTabRpc();
	const tabKey = useTabPollKey();
	const key = scope ? `${tabKey}\n${scope}` : tabKey;

	useEffect(() => {
		if (!active) return;
		const feed = poll.feed(key);
		const reader = { rpc };
		feed.readers.add(reader);
		// The first surface starts the poll; each later one reads once more, as a surface did on its own mount
		// (the work board mounts mid-turn, after the sidebar's read, and must not wait for the next poll).
		if (feed.poller) feed.poller.read();
		else
			feed.poller = poll.start(
				() => feed.readers.values().next().value?.rpc,
				update => show(feed, update),
			);
		return () => {
			feed.readers.delete(reader);
			if (feed.readers.size === 0) {
				feed.poller?.stop();
				feed.poller = null;
			}
			poll.release(key, feed);
		};
	}, [poll, key, active, rpc]);

	const subscribe = useCallback(
		(listener: () => void) => {
			const feed = poll.feed(key);
			feed.listeners.add(listener);
			return () => {
				feed.listeners.delete(listener);
				poll.release(key, feed);
			};
		},
		[poll, key],
	);
	// A static render (renderToString in tests) reads the same value.
	const snapshot = () => select(poll.value(key));
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
