/**
 * A tab a paired host keeps running for this computer that this computer's saved layout does not name comes back
 * (21 Oct 2026: an update restart's stalled first quit rewrote the layout without the host's tab, so the relaunch
 * never reopened it). Asked of the host when its link comes up (`tabs.kept`); a session a local tab already holds is
 * left to that tab, whose own `tab.open` re-attaches it.
 */
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type { KeptTab } from "./app-protocol";

export interface HostTabReadopt {
	/** The host's answer; null when it cannot say (an older OMPdesk). */
	kept(deviceId: string): Promise<KeptTab[] | null>;
	/** A tab here already holds the session on that host. */
	holds(deviceId: string, sessionPath: string): boolean;
	/** Open the tab in the front window, naming the ids the host knows it by; its id, null when none opens. */
	open(deviceId: string, tab: KeptTab): string | null;
	log(step: string, details: Record<string, unknown>): void;
}

/** The ids of the tabs opened. A host that is away or cannot say opens none. */
export async function readoptHostTabs(deviceId: string, deps: HostTabReadopt): Promise<string[]> {
	let kept: KeptTab[] | null;
	try {
		kept = await deps.kept(deviceId);
	} catch (error) {
		if (isAway(error)) return [];
		deps.log("readopt-failed", { device: deviceId, error: error instanceof Error ? error.message : String(error) });
		return [];
	}
	const opened: string[] = [];
	for (const tab of kept ?? []) {
		if (deps.holds(deviceId, tab.sessionPath)) continue;
		const tabId = deps.open(deviceId, tab);
		if (!tabId) continue;
		opened.push(tabId);
		deps.log("readopt", {
			device: deviceId,
			rtab: tab.rtab,
			formerRtabs: tab.formerRtabs,
			session: tab.sessionPath.split(/[\\/]/).pop(),
			state: tab.state,
			tab: tabId,
		});
	}
	return opened;
}

function isAway(error: unknown): boolean {
	const code = ipcErrorCode(error);
	return code === "remote_offline" || code === "remote_unknown_device";
}
