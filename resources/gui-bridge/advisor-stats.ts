// Defer stock imports until guard succeeds: incompatible omp modules must not prevent bridge startup.
import { ADVISOR_STATS_METHOD } from "./advisor-stats-contracts";
import { advisorUsage } from "./advisor-stats-core";
import { guard } from "./health";
import type { BridgeMethods } from "./types";

/**
 * The advisor's spend and delivered advisories, read from the numbers stock keeps: `getAdvisorStats()` (what
 * `/advisor status` shows), `isAdvisorUsingSubscription()` and the `advisor` notes in the session branch.
 */
export const methods: BridgeMethods = guard("advisorStats", {
	/** `{}` → `AdvisorUsage` (advisor-stats-contracts.ts). */
	[ADVISOR_STATS_METHOD]: async (_params, env) => {
		const session = env.session();
		return advisorUsage(
			session.getAdvisorStats(),
			session.isAdvisorUsingSubscription(),
			session.sessionManager.getBranch(),
		);
	},
});
