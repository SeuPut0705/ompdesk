/**
 * Subagent lifecycle actions (stop / revive) shared by Agents › Live and the
 * sidebar's per-session subagent rows: one RPC path, one failure vocabulary.
 */

import type { TabRpc } from "../../lib/tab-rpc";
import { toast, toastError } from "../../stores/toast";

const REASON_KEY: Record<string, string> = {
	advisor_readonly: "agentHub.hub.reason.advisorReadonly",
	main_agent: "agentHub.hub.reason.mainAgent",
	not_found: "agentHub.hub.reason.notFound",
	not_parked: "agentHub.hub.reason.notParked",
};

/**
 * Run a stop/revive against the subagent's own tab. Failures surface as a
 * toast; resolves true only when the sidecar confirmed the action, so callers
 * refresh the roster (a release/revival may not emit a frame).
 */
export async function runSubagentAction(
	rpc: Pick<TabRpc, "abortSubagent" | "reviveSubagent">,
	id: string,
	action: "abort" | "revive",
	t: (key: string, params?: Record<string, string | number>) => string,
): Promise<boolean> {
	const failTitle = action === "abort" ? t("agentHub.hub.abortAgentFailed") : t("agentHub.hub.reviveFailed");
	try {
		const res = action === "abort" ? await rpc.abortSubagent(id) : await rpc.reviveSubagent(id);
		if (!res.success) {
			toastError({ title: failTitle, error: res });
			return false;
		}
		const data = res.data as { ok?: boolean; reason?: string } | undefined;
		if (!data?.ok) {
			const reasonKey = (data?.reason && REASON_KEY[data.reason]) || "agentHub.hub.reason.abortFailed";
			toast({ variant: "error", title: failTitle, message: t(reasonKey) });
			return false;
		}
		return true;
	} catch (cause) {
		toastError({ title: failTitle, error: cause });
		return false;
	}
}
