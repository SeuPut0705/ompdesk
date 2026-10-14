import type { ReactNode } from "react";
import { SessionRuntimeProvider, useTabSessionRuntime } from "../stores/session-runtime-context";
import { ensureTabRuntime } from "../stores/tab-runtime";

/**
 * Provide a tab's current runtime. A session change on the same tab (a drop,
 * `/new`, a resume) replaces the runtime without a tab switch or a status
 * change, so a provider that read the runtime once would keep handing the
 * retired one to everything below it, whose every command then refuses as
 * "the originating session was replaced".
 */
export function TabRuntimeProvider({ tabId, children }: { tabId: string; children: ReactNode }) {
	const runtime = useTabSessionRuntime(tabId) ?? ensureTabRuntime(tabId);
	return <SessionRuntimeProvider runtime={runtime}>{children}</SessionRuntimeProvider>;
}
