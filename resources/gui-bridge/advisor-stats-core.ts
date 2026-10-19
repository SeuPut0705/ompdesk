/**
 * Stock's advisor numbers as the GUI's `AdvisorUsage` (advisor-stats-contracts.ts). Pure: no omp imports, so the GUI's
 * own vitest runs it on fake inputs (src/main/bridge-advisor-stats.test.ts).
 */
import { ADVISOR_SEVERITIES, type AdvisorSeverity, type AdvisorUsage } from "./advisor-stats-contracts";

/** The slice of stock's `AdvisorStats` this reads. */
export interface AdvisorStatsLike {
	configured: boolean;
	active: boolean;
	cost: number;
	tokens: { input: number; output: number; cacheRead: number; total: number };
	advisors: readonly {
		name: string;
		status: string;
		model?: { provider: string; id: string };
		messages: { assistant: number };
		cost: number;
	}[];
}

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

const isSeverity = (value: unknown): value is AdvisorSeverity =>
	ADVISOR_SEVERITIES.some(severity => severity === value);

/** The delivered notes of one journal entry: `custom_message` of `customType: "advisor"` with `details.notes`. */
function notesOf(entry: unknown): readonly unknown[] {
	if (typeof entry !== "object" || entry === null) return [];
	if (!("type" in entry) || entry.type !== "custom_message") return [];
	if (!("customType" in entry) || entry.customType !== "advisor") return [];
	if (!("details" in entry) || typeof entry.details !== "object" || entry.details === null) return [];
	return "notes" in entry.details && Array.isArray(entry.details.notes) ? entry.details.notes : [];
}

function countAdvisories(branch: readonly unknown[]): AdvisorUsage["advisories"] {
	const counts: AdvisorUsage["advisories"] = { total: 0, blocker: 0, concern: 0, nit: 0, other: 0 };
	for (const entry of branch) {
		for (const note of notesOf(entry)) {
			if (typeof note !== "object" || note === null) continue;
			counts.total++;
			const severity = "severity" in note ? note.severity : undefined;
			counts[isSeverity(severity) ? severity : "other"]++;
		}
	}
	return counts;
}

export function advisorUsage(stats: AdvisorStatsLike, subscription: boolean, branch: readonly unknown[]): AdvisorUsage {
	const advisors = stats.advisors.map(advisor => ({
		name: advisor.name,
		status: advisor.status,
		model: advisor.model ? `${advisor.model.provider}/${advisor.model.id}` : undefined,
		calls: finite(advisor.messages.assistant),
		cost: finite(advisor.cost),
	}));
	return {
		configured: stats.configured,
		active: stats.active,
		subscription,
		cost: finite(stats.cost),
		calls: advisors.reduce((sum, advisor) => sum + advisor.calls, 0),
		tokens: {
			input: finite(stats.tokens.input),
			output: finite(stats.tokens.output),
			cacheRead: finite(stats.tokens.cacheRead),
			total: finite(stats.tokens.total),
		},
		advisories: countAdvisories(branch),
		advisors,
	};
}
