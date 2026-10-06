import type { SessionInfo } from "../../shared/ipc-types";

/** One display-title contract shared by the sidebar and top tab strip. */
export function sessionDisplayTitle(session: Pick<SessionInfo, "title" | "firstMessage">, untitled: string): string {
	return session.title?.trim() || session.firstMessage.trim() || untitled;
}

/** True once a session has user-visible conversation content. */
export function sessionHasContent(session: Pick<SessionInfo, "title" | "firstMessage" | "messageCount">): boolean {
	return session.messageCount > 0 || Boolean(session.title?.trim() || session.firstMessage.trim());
}
