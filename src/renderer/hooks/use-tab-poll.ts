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

	/** The tab's value while some surface polls it, else the initial one: a value nobody re-reads is no fact. */
	polledValue(key: string): T {
		const feed = this.#feeds.get(key);
		return feed?.poller ? feed.value : this.initial;
	}

	subscribe(key: string, listener: () => void): () => void {
		const feed = this.feed(key);
		feed.listeners.add(listener);
		return () => {
			feed.listeners.delete(listener);
			this.release(key, feed);
		};
	}
}

function show<T>(feed: Feed<T>, update: (current: T) => T): void {
	const value = update(feed.value);
	if (Object.is(value, feed.value)) return;
	feed.value = value;
	notify(feed);
}

/** Every surface showing the feed re-reads it; one that selects the same value does not re-render. */
function notify<T>(feed: Feed<T>): void {
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
 * re-renders only when what it selects changes.
 */
export function useTabPoll<T, S>(poll: TabPoll<T>, active: boolean, select: (value: T) => S): S {
	const rpc = useTabRpc();
	const key = useTabPollKey();

	useEffect(() => {
		if (!active) return;
		const feed = poll.feed(key);
		const reader = { rpc };
		feed.readers.add(reader);
		// The first surface starts the poll; each later one reads once more, as a surface did on its own mount
		// (the work board mounts mid-turn, after the sidebar's read, and must not wait for the next poll).
		if (feed.poller) feed.poller.read();
		else {
			feed.poller = poll.start(
				() => feed.readers.values().next().value?.rpc,
				update => show(feed, update),
			);
			// Surfaces that only peek (`useTabPollPeek`) see the value again now that it is re-read.
			notify(feed);
		}
		return () => {
			feed.readers.delete(reader);
			if (feed.readers.size === 0) {
				feed.poller?.stop();
				feed.poller = null;
				notify(feed);
			}
			poll.release(key, feed);
		};
	}, [poll, key, active, rpc]);

	const subscribe = useCallback((listener: () => void) => poll.subscribe(key, listener), [poll, key]);
	// A static render (renderToString in tests) reads the same value.
	const snapshot = () => select(poll.value(key));
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * `select` of `key`'s value of `poll` without polling it: the value while another surface of that tab polls it (the
 * tab's pane is on screen), else the initial one. For a list of many tabs (the sidebar) that must not start a poll
 * per tab and must not show a value nobody re-reads any more.
 */
export function useTabPollPeek<T, S>(poll: TabPoll<T>, key: string, select: (value: T) => S): S {
	const subscribe = useCallback((listener: () => void) => poll.subscribe(key, listener), [poll, key]);
	const snapshot = () => select(poll.polledValue(key));
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
