import { useEffect } from "react";
import { useStore } from "zustand";
import type { SessionInfo } from "../../shared/ipc-types";
import { type SessionListScope, sessionListFeed } from "../stores/session-list";

interface SessionListResult {
	sessions: SessionInfo[];
	isLoading: boolean;
	/** A live read has answered (the rows are what exists, not a last-known snapshot). */
	live: boolean;
	/** Set when the last read failed; an empty list must not claim "nothing here". */
	error: string | null;
	refresh: (showSpinner?: boolean) => void;
	deleteSession: (path: string) => Promise<void>;
	renameSession: (path: string, name: string) => Promise<void>;
}

/**
 * The session list and its change subscription, shared by every caller of
 * the same scope and device (see stores/session-list.ts for the refresh
 * rules). `device` = paired host deviceId; absent = this device. `read: false` shows the last known rows without
 * asking (a paired host whose link is not up yet).
 */
export function useSessionList(
	scope: SessionListScope = "local",
	device?: string,
	{ read = true }: { read?: boolean } = {},
): SessionListResult {
	const feed = sessionListFeed(scope, device);
	useEffect(() => (read ? feed.retain() : undefined), [feed, read]);
	const { sessions, isLoading, live, error } = useStore(feed.store);
	return {
		sessions,
		isLoading,
		live,
		error,
		refresh: feed.refresh,
		deleteSession: feed.deleteSession,
		renameSession: feed.renameSession,
	};
}
