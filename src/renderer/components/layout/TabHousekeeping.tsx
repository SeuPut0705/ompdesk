/**
 * Tab lifecycle chores that used to ride on the (removed) tab strip. Session
 * tabs are pooled sidecars navigated from the sidebar; nothing here renders.
 *
 * - A ⌘W-armed close (live run) auto-cancels after `confirmCloseMs`.
 * - The untargeted startup tab is an idle landing surface, not a permanent
 *   tab: once an explicit tab exists it is closed, but only while it is truly
 *   empty — a typed draft, queued input, message or live run makes it real.
 *   The first-chat fallback cleans up layouts saved before the placeholder bit
 *   existed, after SessionIndex confirms that transcript has no content.
 */

import { useEffect, useMemo, useRef } from "react";
import { useSessionList } from "../../hooks/use-session-list";
import { sessionHasContent } from "../../lib/session-title";
import { type ComposerStore, useComposerStore } from "../../stores/composer";
import { type MessagesStore, useMessagesStore } from "../../stores/messages";
import { type QueueStore, useQueueStore } from "../../stores/queue";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore } from "../../stores/session-runtime-context";
import { isTabClosed, useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";

/** Auto-cancel window for the armed close confirm (injectable for tests). */
const CONFIRM_CLOSE_MS = 3000;

export function TabHousekeeping({ confirmCloseMs = CONFIRM_CLOSE_MS }: { confirmCloseMs?: number }) {
	const { sessions } = useSessionList("global");
	const tabs = useTabsStore(s => s.tabs);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const closeTab = useTabsStore(s => s.closeTab);
	const liveDraft = useComposerStore(s => s.draft);
	const liveImageCount = useComposerStore(s => s.images.length);
	const liveMessageCount = useSessionStore(s => s.messageCount);
	const liveStreaming = useSessionStore(s => s.isStreaming);
	const liveCompacting = useSessionStore(s => s.isCompacting);
	const liveRenderedMessages = useMessagesStore(s => s.messages.length);
	const liveQueuedMessages = useQueueStore(s => s.steering.length + s.followUp.length);
	const armedCloseTab = useUiStore(s => s.armedCloseTab);
	const cancelCloseTab = useUiStore(s => s.cancelCloseTab);
	const pruningPlaceholderRef = useRef<string | null>(null);
	const sessionsById = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);
	const sessionsByPath = useMemo(() => new Map(sessions.map(session => [session.path, session])), [sessions]);

	useEffect(() => {
		if (!armedCloseTab) return;
		const timer = window.setTimeout(cancelCloseTab, confirmCloseMs);
		return () => window.clearTimeout(timer);
	}, [armedCloseTab, cancelCloseTab, confirmCloseMs]);

	useEffect(() => {
		if (tabs.length <= 1 || pruningPlaceholderRef.current) return;
		const candidate = tabs.find((tab, index) => {
			const indexedSession =
				(tab.sessionPath ? sessionsByPath.get(tab.sessionPath) : undefined) ??
				(tab.sessionId ? sessionsById.get(tab.sessionId) : undefined);
			const legacyEmptyStartupChat =
				index === 0 &&
				tab.placeholder === undefined &&
				tab.kind === "chat" &&
				indexedSession !== undefined &&
				!sessionHasContent(indexedSession);
			if (tab.placeholder !== true && !legacyEmptyStartupChat) return false;
			if (indexedSession && sessionHasContent(indexedSession)) return false;
			if (tab.worktree || tab.pendingSessionPath || tab.status === "running" || tab.compacting) return false;
			// A tab already closing (its session is being deleted) is no reason for the start tab to go.
			if (!tabs.some(other => other.id !== tab.id && other.placeholder !== true && !isTabClosed(other.id)))
				return false;

			if (tab.id === activeTabId) {
				return (
					!liveStreaming &&
					!liveCompacting &&
					liveMessageCount === 0 &&
					liveRenderedMessages === 0 &&
					liveQueuedMessages === 0 &&
					liveDraft.trim().length === 0 &&
					liveImageCount === 0
				);
			}

			const session = sessionRuntimeStore<SessionStore>(tab.id, "session")?.getState();
			const messages = sessionRuntimeStore<MessagesStore>(tab.id, "messages")?.getState();
			const queue = sessionRuntimeStore<QueueStore>(tab.id, "queue")?.getState();
			const composer = sessionRuntimeStore<ComposerStore>(tab.id, "composer")?.getState();
			if (!session || !messages || !queue || !composer) return true;
			return (
				!session.isStreaming &&
				!session.isCompacting &&
				session.messageCount === 0 &&
				messages.messages.length === 0 &&
				queue.steering.length === 0 &&
				queue.followUp.length === 0 &&
				composer.draft.trim().length === 0 &&
				composer.images.length === 0
			);
		});
		if (!candidate) return;
		pruningPlaceholderRef.current = candidate.id;
		void closeTab(candidate.id).finally(() => {
			pruningPlaceholderRef.current = null;
		});
	}, [
		activeTabId,
		closeTab,
		liveCompacting,
		liveDraft,
		liveImageCount,
		liveMessageCount,
		liveQueuedMessages,
		liveRenderedMessages,
		liveStreaming,
		sessionsById,
		sessionsByPath,
		tabs,
	]);

	return null;
}
