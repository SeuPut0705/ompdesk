/**
 * The tab's slash commands (stock's plus the GUI's own), kept current across sidecar startup and extension reloads.
 */
import { useEffect, useState } from "react";
import type { AvailableCommand } from "../../../../shared/rpc-types";
import { withGuiCommands } from "../../../lib/command-registry";
import type { TabRpc } from "../../../lib/tab-rpc";
import type { SessionStore } from "../../../stores/session";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";

export function useComposerCommands({
	rpc,
	status,
	sessionId,
	runtimeTabId,
}: {
	rpc: TabRpc;
	status: string;
	sessionId: string | null;
	runtimeTabId: string | null;
}): AvailableCommand[] {
	const [commands, setCommands] = useState<AvailableCommand[]>([]);
	useEffect(() => {
		let cancelled = false;
		const unsubscribe = window.omp.events.onTabCommandsUpdate((next, tabId) => {
			if (!cancelled && tabId === runtimeTabId) setCommands(withGuiCommands(next));
		});
		const load = () => {
			if (status !== "ready" || !runtimeTabId) return;
			void rpc.getAvailableCommands().then(res => {
				if (
					cancelled ||
					sessionRuntimeStore<SessionStore>(runtimeTabId, "session")?.getState().sessionId !== sessionId ||
					!res.success
				)
					return;
				const data = res.data as { commands?: AvailableCommand[] } | undefined;
				setCommands(withGuiCommands(data?.commands ?? []));
			});
		};
		load();
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [status, sessionId, runtimeTabId, rpc]);
	return commands;
}
