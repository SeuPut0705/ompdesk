/**
 * Usage reports of the owner's 0.128.0 report (14 Nov 2026), under made-up addresses: three Claude accounts at a
 * narrow sidebar, the first without a 5H window, the session's own at its 7D and Fable limits with a blocked
 * rotation decision, the third with room. The dev harness serves it for `?usage=blocked` and the fake omp for
 * `OMP_GUI_TEST_USAGE_ACCOUNTS=blocked` (`e2e/fixture/rpc-ui.ts`), so the sidebar usage e2e and the parity sheet draw
 * the same block.
 */
import type { UsageReport } from "../../shared/rpc-types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function claude(
	credentialId: number,
	account: string,
	now: number,
	windows: Array<[span: "5h" | "7d", used: number, resetsIn: number, model?: string]>,
	rest: Partial<UsageReport> = {},
): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: now - 90_000,
		account,
		credentialId,
		limits: windows.map(([span, used, resetsIn, model]) => ({
			id: `anthropic:${span}${model ? `:${model.toLowerCase()}` : ""}`,
			label: model ? `Claude 7 Day (${model})` : span === "5h" ? "5 hour" : "7 day",
			windowId: span,
			usedFraction: used,
			resetsAt: now + resetsIn,
		})),
		...rest,
	};
}

export function blockedAccountUsage(now = Date.now(), similar = false): UsageReport[] {
	return [
		claude(1, "avery.2952@example.com", now, [
			["7d", 1, 83 * HOUR],
			["7d", 0.14, 83 * HOUR, "Fable"],
		]),
		claude(
			2,
			"morgan95@example.com",
			now,
			[
				["5h", 0.19, 10 * MINUTE],
				["7d", 1, 41 * HOUR],
				["7d", 1, 41 * HOUR, "Fable"],
			],
			{ active: true, lastUsedAt: now - 30_000, rotation: { why: "blocked", moved: false, phase: "turn", at: now } },
		),
		claude(3, "taylor.r@example.com", now, [
			["5h", 0.04, 4 * HOUR],
			["7d", 0.31, 120 * HOUR],
			["7d", 0.22, 120 * HOUR, "Fable"],
		]),
	].map(report =>
		similar
			? {
					...report,
					account: `avery.long.account.with.a.matching.prefix@company-${report.credentialId}.example.com`,
				}
			: report,
	);
}

export function manyWindowUsage(now = Date.now()): UsageReport[] {
	return blockedAccountUsage(now).map(report => ({
		...report,
		limits: [
			...report.limits,
			...["Opus", "Sonnet"].map((model, index) => ({
				id: `anthropic:7d:${model.toLowerCase()}`,
				label: `Claude 7 Day (${model})`,
				windowId: "7d",
				usedFraction: (index + 1) * 0.25,
				resetsAt: now + 90 * HOUR,
			})),
		],
	}));
}

export function usageFigureReports(now = Date.now()): UsageReport[] {
	return [
		{
			provider: "devin",
			fetchedAt: now,
			account: "devin@example.com",
			credentialId: 1,
			limits: [],
			notes: ["Overage balance: $12.50"],
		},
		{
			provider: "github-copilot",
			fetchedAt: now,
			account: "copilot@example.com",
			credentialId: 2,
			limits: [
				{
					id: "copilot:premium",
					label: "Premium requests",
					used: 24,
					limit: 100,
					unit: "requests",
					notes: ["Overage requests: 17"],
				},
			],
		},
	];
}
