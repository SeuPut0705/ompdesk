/**
 * One source-control mutation at a time: runs the command on the tab's
 * checkout, keeps which action is busy, toasts a failure in the UI language
 * (the typed `code` maps to `ipcError.*`), reports a stop on conflicts, and
 * reloads the panel afterwards either way.
 */
import { useCallback, useRef, useState } from "react";
import type { RpcCommand } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { toast, toastError } from "../../../stores/toast";

export interface ScmRunOptions {
	/** Toast title when the command fails. */
	failure: string;
	/** Toast title when it succeeds; none by default (the panel itself shows the result). */
	success?: string;
}

export interface ScmRunner {
	/** Key of the running action, or null. */
	busy: string | null;
	/** Resolves with the response data, or undefined when it failed (already toasted). */
	run: <T = unknown>(key: string, command: RpcCommand, options: ScmRunOptions) => Promise<T | undefined>;
}

export function useScmAction(rpc: TabRpc, onSettled: () => void): ScmRunner {
	const t = useT();
	const [busy, setBusy] = useState<string | null>(null);
	const running = useRef(false);
	const run = useCallback(
		async <T>(key: string, command: RpcCommand, options: ScmRunOptions): Promise<T | undefined> => {
			if (running.current) return undefined;
			running.current = true;
			setBusy(key);
			try {
				const response = await rpc.command(command);
				if (!response.success) {
					toastError({ title: options.failure, error: response });
					return undefined;
				}
				const data = response.data as T;
				const conflicts =
					data && typeof data === "object" && "conflicts" in data && typeof data.conflicts === "number"
						? data.conflicts
						: 0;
				if (conflicts > 0) {
					toast({ variant: "warning", message: t("scm.stoppedOnConflicts", { count: conflicts }) });
				} else if (options.success) {
					toast({ variant: "success", message: options.success });
				}
				return data;
			} catch (error) {
				toastError({ title: options.failure, error });
				return undefined;
			} finally {
				running.current = false;
				setBusy(null);
				onSettled();
			}
		},
		[rpc, onSettled, t],
	);
	return { busy, run };
}
