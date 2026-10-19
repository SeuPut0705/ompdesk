/**
 * A paired device's `get_autopilot` / `set_autopilot` on its tab here (LocalHostServices `attachAutopilot`): this
 * computer's Autopilot coordinator answers, as for a tab of its own windows, so a run of a folder on this computer
 * is this computer's run (its worktree, guard, ShipRunner and restart resume) whichever device asked.
 *
 * - A device tab that views a window's tab (`viewForDevice`: the device opened a run's session) is that window's
 *   tab to the coordinator.
 * - Any other device tab is a run's source: the coordinator reads it by its resume id (its pool falls back to the
 *   device tabs), and the run it starts is a tab of this computer's frontmost window, never the device's tab here:
 *   a device tab closes with the device's close or grace period, which would end an unattended run.
 * - A start's answer also names the run's session file, so the device opens that session as a view of the run.
 */
import type { RpcResponse } from "../../shared/rpc-types";
import type { AutopilotCommand } from "../autopilot";
import type { SidecarPool } from "../sidecar-pool";
import type { SidecarLike } from "../sidecar-types";
import type { ClientWindow } from "../web/client-window";
import type { HostedAutopilot } from "./host-services";

export interface HostedAutopilotDeps {
	pool: Pick<SidecarPool, "sessionOwner" | "sidecarOf" | "windowOfTab">;
	/** This computer's window a new run opens in (the focused one, else the first). */
	targetWindow(): ClientWindow | null;
	/** `Autopilot.handleCommand`. */
	handle(win: ClientWindow, sidecar: SidecarLike, tabId: string, command: AutopilotCommand): Promise<RpcResponse>;
}

function refused(command: string, error: string): RpcResponse {
	return { type: "response", command, success: false, error } as RpcResponse;
}

export function hostedAutopilot(deps: HostedAutopilotDeps): HostedAutopilot {
	return async (target, raw) => {
		const command = raw as unknown as AutopilotCommand;
		const owner = target.viewsWindow && target.sessionPath ? deps.pool.sessionOwner(target.sessionPath) : null;
		const tabId = owner?.tabId ?? target.tabId;
		const sidecar = owner ? deps.pool.sidecarOf(owner.tabId) : target.sidecar;
		const win = (owner && deps.pool.windowOfTab(owner.tabId)) ?? deps.targetWindow();
		if (!sidecar) return refused(command.type, "That session's tab is gone on this computer.");
		if (!win) return refused(command.type, "Autopilot needs a window of OMPdesk open on this computer.");
		const response = await deps.handle(win, sidecar, tabId, command);
		if (!response.success || command.type !== "set_autopilot" || command.action !== "start") return response;
		const data = response.data as { tabId?: unknown } | undefined;
		const run = typeof data?.tabId === "string" ? deps.pool.sidecarOf(data.tabId) : null;
		const state = await run?.rpcClient?.command({ type: "get_state" }).catch(() => null);
		const sessionPath = (state?.data as { sessionFile?: unknown } | undefined)?.sessionFile;
		return typeof sessionPath === "string" ? { ...response, data: { ...data, sessionPath } } : response;
	};
}
