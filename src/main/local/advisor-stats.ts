/**
 * The advisor's spend, calls and delivered advisories for the Run popover and Insights. The tab's omp answers
 * through the bridge (advisor-stats.ts); a tab a host runs for a paired device answers on the host.
 */
import { ADVISOR_STATS_METHOD, type AdvisorUsage } from "../../../resources/gui-bridge/advisor-stats-contracts";
import type { LocalHandler } from "./types";

export const handlers: Record<string, LocalHandler> = {
	get_advisor_stats: (_command, ctx) => ctx.bridge.request<AdvisorUsage>(ADVISOR_STATS_METHOD, {}),
};
