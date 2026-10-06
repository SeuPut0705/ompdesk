import { useMemo } from "react";
import { createSessionRpcClient, type SessionRpcClient } from "../../shared/rpc-client";
import { activeTabCommand, focusedSessionRuntime, useSessionRuntime } from "../stores/session-runtime-context";

export type TabRpc = SessionRpcClient;
export const createTabRpc = createSessionRpcClient;

export function useTabRpc(): TabRpc {
	const runtime = useSessionRuntime();
	return useMemo(() => {
		if (runtime) return createTabRpc(runtime.command);
		return typeof window !== "undefined" && window.omp?.rpc ? window.omp.rpc : createTabRpc(activeTabCommand);
	}, [runtime]);
}

/** Capture the selected task once for an imperative action, before its first await. */
export function focusedTabRpc(): TabRpc {
	const runtime = focusedSessionRuntime();
	return runtime ? createTabRpc(runtime.command) : window.omp.rpc;
}
