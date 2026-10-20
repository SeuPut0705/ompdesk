import { useCallback, useState } from "react";
import type { AutopilotAction, AutopilotStatus } from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { tabAutopilotStore } from "../../../stores/autopilot";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { toastError } from "../../../stores/toast";

/** How long a started run's new tab may take to reach this window's tab list before focusing it is given up. */
const NEW_TAB_WAIT_MS = 10_000;

function isStatus(value: unknown): value is AutopilotStatus {
	return typeof value === "object" && value !== null && "active" in value && typeof value.active === "boolean";
}

/** A start's answer: the run's new tab (this computer's), and on a paired host the run's session file there. */
function startedRun(value: unknown): { tabId?: string; sessionPath?: string } {
	if (typeof value !== "object" || value === null) return {};
	const { tabId, sessionPath } = value as Record<string, unknown>;
	return {
		...(typeof tabId === "string" ? { tabId } : {}),
		...(typeof sessionPath === "string" ? { sessionPath } : {}),
	};
}

/** Main spawns the run's worktree tab and focuses nothing: show it as soon as this window's tab list has it. */
function focusWhenListed(tabId: string): void {
	const listed = () => useTabsStore.getState().tabs.some(tab => tab.id === tabId);
	if (listed()) {
		void useTabsStore.getState().switchTab(tabId);
		return;
	}
	const stop = () => {
		unsubscribe();
		clearTimeout(timer);
	};
	const unsubscribe = useTabsStore.subscribe(() => {
		if (!listed()) return;
		stop();
		void useTabsStore.getState().switchTab(tabId);
	});
	const timer = setTimeout(stop, NEW_TAB_WAIT_MS);
}

/**
 * The Autopilot controls of the tab this component sits in: one `set_autopilot` call at a time, a failure shown as a
 * toast with the coordinator's own words (main refuses a start with a readable reason). `start` answers with the new
 * worktree tab, which is focused; on a paired host's tab the run is a tab of the host's window, so this device opens
 * the run's session (a view of that tab: one omp). Every other answer that is the whole status goes straight to the
 * store (the `autopilot_update` frame follows either way).
 */
export function useAutopilotActions(): {
	pending: AutopilotAction["action"] | null;
	run: (action: AutopilotAction) => Promise<boolean>;
} {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const [pending, setPending] = useState<AutopilotAction["action"] | null>(null);
	const run = useCallback(
		async (action: AutopilotAction): Promise<boolean> => {
			setPending(action.action);
			try {
				const response = await rpc.setAutopilot(action);
				if (!response.success) throw new Error(response.error);
				if (action.action === "start") {
					const started = startedRun(response.data);
					const device = useTabsStore.getState().tabs.find(tab => tab.id === tabId)?.device;
					if (device && started.sessionPath) {
						await useTabsStore.getState().openTab({ sessionPath: started.sessionPath, device });
					} else if (started.tabId) focusWhenListed(started.tabId);
				} else if (isStatus(response.data)) {
					tabAutopilotStore(tabId).getState().apply(response.data);
				}
				return true;
			} catch (cause) {
				toastError({ title: t("autopilot.actionFailed"), error: cause });
				return false;
			} finally {
				setPending(null);
			}
		},
		[rpc, t, tabId],
	);
	return { pending, run };
}
