import { useEffect } from "react";
import { useStore } from "zustand";
import type { SessionInfo } from "../../shared/ipc-types";
import { type SessionListScope, sessionListFeed } from "../stores/session-list";

interface SessionListResult {
	sessions: SessionInfo[];
	isLoading: boolean;
	/** Set when the last read failed; an empty list must not claim "nothing here". */
	error: string | null;
	refresh: (showSpinner?: boolean) => void;
	deleteSession: (path: string) => Promise<void>;
	renameSession: (path: string, name: string) => Promise<void>;
}

/**
 * The session list and its change subscription, shared by every caller of
 * the same scope (see stores/session-list.ts for the refresh rules).
 */
export function useSessionList(scope: SessionListScope = "local"): SessionListResult {
	const feed = sessionListFeed(scope);
	useEffect(() => feed.retain(), [feed]);
	const { sessions, isLoading, error } = useStore(feed.store);
	return {
		sessions,
		isLoading,
		error,
		refresh: feed.refresh,
		deleteSession: feed.deleteSession,
		renameSession: feed.renameSession,
	};
}
