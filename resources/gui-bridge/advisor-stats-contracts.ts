/**
 * What the GUI shows of this session's advisor (stock `advisor.enabled`, a second model reviewing every turn):
 * its spend, its model calls and the advisories it delivered into the transcript. Dependency-free: main, the
 * renderer and the bridge (`advisor-stats.ts`) import it.
 *
 * Read from stock's own numbers, never re-derived: `AgentSession.getAdvisorStats()` (what `/advisor status` shows)
 * gives cost and calls, `isAdvisorUsingSubscription()` the billing, and the session branch's `custom_message`
 * entries of `customType: "advisor"` the delivered notes (`details.notes[].severity`, stock's `AdvisorSeverity`).
 */

/** The bridge method (`advisor-stats.ts`); main's local RPC command is `get_advisor_stats`. */
export const ADVISOR_STATS_METHOD = "advisor_stats";

/** Stock's advisor severities, loudest first. */
export const ADVISOR_SEVERITIES = ["blocker", "concern", "nit"] as const;
export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

/** One configured advisor (stock `PerAdvisorStat`, flattened). */
export interface AdvisorUsageEntry {
	/** Stock's advisor name (`default` for the unnamed one). */
	name: string;
	/** Stock `AdvisorRuntimeStatus`: running | paused | no_model | quota_exhausted | error. */
	status: string;
	/** `provider/id` of the model it runs on, when live. */
	model?: string;
	/** Model calls (assistant messages) since its context last started; compaction re-primes it. */
	calls: number;
	/** USD, whole session (stock's ledger, restored from the advisor transcripts on resume). */
	cost: number;
}

export interface AdvisorUsage {
	/** Stock `advisor.enabled`. */
	configured: boolean;
	/** At least one advisor runs now. */
	active: boolean;
	/** The advisor bills an OAuth/subscription plan: the cost is the list price, not a charge. */
	subscription: boolean;
	/** USD, whole session (`getAdvisorStats().cost`). */
	cost: number;
	/** Sum of the entries' `calls`. */
	calls: number;
	/** Live advisors' tokens since their context last started. */
	tokens: { input: number; output: number; cacheRead: number; total: number };
	/** Notes delivered into this session's branch (one advisor card can carry several). */
	advisories: { total: number; other: number } & Record<AdvisorSeverity, number>;
	advisors: AdvisorUsageEntry[];
}
