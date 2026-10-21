/**
 * A tab a paired host keeps running for this computer comes back attached after this computer relaunches (21 Oct
 * 2026: an update restart's stalled first quit rewrote the layout without the host's tab, so the relaunch never
 * reopened it; and a host tab the layout kept came back deferred, "not started", until someone looked at it, while
 * the host's omp ran on unseen). Asked of the host when its link comes up (`tabs.kept`): a session a tab here
 * already holds is started in that tab, whose `tab.open` re-attaches it; any other is opened in the front window.
 */
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type { KeptTab } from "./app-protocol";

export interface HostTabReadopt {
	/** The host's answer; null when it cannot say (an older OMPdesk). */
	kept(deviceId: string): Promise<KeptTab[] | null>;
	/** The tab here that already holds the session on that host, if any. */
	holder(deviceId: string, sessionPath: string): string | null;
	/** Start the tab's process if the layout restored it deferred; true when it did. */
	start(tabId: string): boolean;
	/** Open the tab in the front window, naming the ids the host knows it by; its id, null when none opens. */
	open(deviceId: string, tab: KeptTab): string | null;
	log(step: string, details: Record<string, unknown>): void;
}

/** The ids of the tabs opened or started. A host that is away or cannot say brings none back. */
export async function readoptHostTabs(deviceId: string, deps: HostTabReadopt): Promise<string[]> {
	let kept: KeptTab[] | null;
	try {
		kept = await deps.kept(deviceId);
	} catch (error) {
		if (isAway(error)) return [];
		deps.log("readopt-failed", { device: deviceId, error: error instanceof Error ? error.message : String(error) });
		return [];
	}
	const back: string[] = [];
	for (const tab of kept ?? []) {
		const holder = deps.holder(deviceId, tab.sessionPath);
		const tabId = holder ? (deps.start(holder) ? holder : null) : deps.open(deviceId, tab);
		if (!tabId) continue;
		back.push(tabId);
		deps.log("readopt", {
			device: deviceId,
			rtab: tab.rtab,
			formerRtabs: tab.formerRtabs,
			session: tab.sessionPath.split(/[\\/]/).pop(),
			state: tab.state,
			tab: tabId,
			...(holder ? { held: true } : {}),
		});
	}
	return back;
}

function isAway(error: unknown): boolean {
	const code = ipcErrorCode(error);
	return code === "remote_offline" || code === "remote_unknown_device";
}
