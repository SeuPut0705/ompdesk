/**
 * Where an Autopilot notice a paired host sent this device (`host.autopilotNotice`) goes: the tab of this device that
 * shows the run's session hears it like a run of its own, this computer's banner on that tab and the phones paired to
 * this computer (Web Push, which a phone viewing the host's run through this computer would otherwise never get); with
 * no such tab, a plain banner. Each route keeps its own switch (`notifyTab` and `banner` check this computer's).
 */
import type { AutopilotNoticeEvent } from "./remote/app-protocol";
import type { ResumeFact } from "./turn-resume";

export interface HostNoticeRoutes {
	facts(): readonly Pick<ResumeFact, "tabId" | "device" | "sessionFile">[];
	notifyTab(tabId: string, notice: AutopilotNoticeEvent): void;
	webPush(tabId: string, notice: AutopilotNoticeEvent): void;
	banner(notice: AutopilotNoticeEvent): void;
}

export function routeHostAutopilotNotice(routes: HostNoticeRoutes, host: string, notice: AutopilotNoticeEvent): void {
	const shown = notice.sessionPath
		? routes.facts().find(fact => fact.device === host && fact.sessionFile === notice.sessionPath)
		: undefined;
	if (!shown) {
		routes.banner(notice);
		return;
	}
	routes.notifyTab(shown.tabId, notice);
	routes.webPush(shown.tabId, notice);
}
