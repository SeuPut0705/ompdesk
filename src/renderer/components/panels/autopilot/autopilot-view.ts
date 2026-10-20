/**
 * Pure rules of the Autopilot screen, the work-board card and the composer chip: what step the agent is in, the area
 * mix, the cost prediction, the "while you were away" summary and the chip's state. Nothing here reads a store: the
 * components pass in what `get_autopilot` / `autopilot_update` and the tool store already hold.
 */

import {
	AUTOPILOT_AREAS,
	type AutopilotCycleArea,
	type AutopilotCycleRecord,
	type AutopilotPauseReason,
	type AutopilotStatus,
	type ShipQueueItem,
} from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import type { ToolEntry } from "../../../stores/tools";

export const AUTOPILOT_STEPS = ["audit", "implement", "verify", "commit"] as const;
export type AutopilotStep = (typeof AUTOPILOT_STEPS)[number];

type StepCall = Pick<ToolEntry, "toolName" | "args">;

const AUDIT_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	find: true,
	search: true,
	ast_grep: true,
	lsp: true,
	web_search: true,
};
const IMPLEMENT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, notebook: true };
const COMMIT_COMMAND = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
const VERIFY_COMMAND = /\b(?:test|tests|vitest|jest|pytest|playwright|tsc|typecheck|check|check:\w+|lint|gate|build)\b/;
const AUDIT_COMMAND = /\bgit\s+(?:-C\s+\S+\s+)?(?:status|log|diff|show|blame)\b/;

/** The step one tool call belongs to; null for a call that says nothing about it (`ls`, `todo`, `autopilot`). */
export function toolStep(call: StepCall): AutopilotStep | null {
	if (AUDIT_TOOLS[call.toolName]) return "audit";
	if (IMPLEMENT_TOOLS[call.toolName]) return "implement";
	if (call.toolName !== "bash") return null;
	const command = typeof call.args.command === "string" ? call.args.command : "";
	// A commit message may say "test"; the commit wins.
	if (COMMIT_COMMAND.test(command)) return "commit";
	if (VERIFY_COMMAND.test(command)) return "verify";
	if (AUDIT_COMMAND.test(command)) return "audit";
	return null;
}

/** The step the newest classified call of the cycle (oldest first) is in. */
export function autopilotStep(calls: readonly StepCall[]): AutopilotStep | null {
	for (let index = calls.length - 1; index >= 0; index--) {
		const step = toolStep(calls[index] as StepCall);
		if (step) return step;
	}
	return null;
}

/** The current step and the ones before it, which stay done when the agent reads or searches again afterwards. */
export function autopilotProgress(calls: readonly StepCall[]): {
	current: AutopilotStep | null;
	done: AutopilotStep[];
} {
	let reached = -1;
	let current: AutopilotStep | null = null;
	for (const call of calls) {
		const step = toolStep(call);
		if (!step) continue;
		const at = AUTOPILOT_STEPS.indexOf(step);
		if (at >= reached) {
			reached = at;
			current = step;
		}
	}
	return { current, done: AUTOPILOT_STEPS.slice(0, Math.max(0, reached)) };
}

const MIX_ORDER: readonly AutopilotCycleArea[] = [...AUTOPILOT_AREAS, "user", "release"];

export interface AreaMix {
	rows: { area: AutopilotCycleArea; count: number }[];
	total: number;
	max: number;
}

/** Reported cycles per area, in the fixed area order; an unreported cycle belongs to no area. */
export function areaMix(cycles: readonly AutopilotCycleRecord[]): AreaMix {
	const rows = MIX_ORDER.map(area => ({ area, count: cycles.filter(cycle => cycle.area === area).length })).filter(
		row => row.count > 0,
	);
	return {
		rows,
		total: rows.reduce((sum, row) => sum + row.count, 0),
		max: rows.reduce((most, row) => Math.max(most, row.count), 0),
	};
}

/** The cost prediction averages this many of the newest cycles. */
export const RATE_WINDOW = 5;
const HOUR_MS = 3_600_000;

export interface RatePrediction {
	tokensPerHour: number;
	usdPerHour: number;
	sample: number;
}

/** Tokens and dollars an hour at the pace of the last {@link RATE_WINDOW} cycles; needs two cycles with a duration. */
export function ratePrediction(cycles: readonly AutopilotCycleRecord[]): RatePrediction | null {
	const sample = cycles.filter(cycle => cycle.durationMs > 0).slice(-RATE_WINDOW);
	if (sample.length < 2) return null;
	const hours = sample.reduce((sum, cycle) => sum + cycle.durationMs, 0) / HOUR_MS;
	return {
		tokensPerHour: sample.reduce((sum, cycle) => sum + cycle.tokens, 0) / hours,
		usdPerHour: sample.reduce((sum, cycle) => sum + cycle.usd, 0) / hours,
		sample: sample.length,
	};
}

export interface OvernightSummary {
	cycles: number;
	commits: number;
	red: number;
	releases: string[];
	pushes: number;
	failedShips: number;
}

/** What happened while the window was away since `since` (ms): the "overnight card", counted from the journal alone. */
export function overnightSummary(input: {
	cycles: readonly AutopilotCycleRecord[];
	since: number;
	ship: readonly ShipQueueItem[] | undefined;
}): OvernightSummary {
	const finished = input.cycles.filter(cycle => cycle.startedAt + cycle.durationMs >= input.since);
	const steps = (input.ship ?? []).filter(item => item.at >= input.since);
	return {
		cycles: finished.length,
		commits: finished.filter(cycle => cycle.commit).length,
		red: finished.filter(cycle => cycle.verify === "red").length,
		releases: finished.flatMap(cycle => (cycle.ship ? [cycle.ship.version] : [])),
		pushes: steps.filter(item => item.kind === "push" && item.state === "done").length,
		failedShips: steps.filter(item => item.state === "failed").length,
	};
}

export type AutopilotChip =
	| { kind: "running"; cycle: number; area: AutopilotCycleArea | undefined }
	| { kind: "stopping"; cycle: number }
	| { kind: "paused"; cycle: number; reason: AutopilotPauseReason | undefined }
	| { kind: "quota"; cycle: number; until: number | undefined };

/**
 * The composer chip's state, or null when this session is no live run. A running run with a booked usage-limit
 * resume (`reservation`, epoch ms) is waiting for the quota, whether or not the coordinator said so.
 */
export function autopilotChip(status: AutopilotStatus, reservation: number | undefined): AutopilotChip | null {
	if (!status.active || !status.state || status.state === "ended") return null;
	const cycle = status.now?.n ?? status.cycle ?? 0;
	switch (status.state) {
		case "stopping":
			return { kind: "stopping", cycle };
		case "paused":
			return {
				kind: "paused",
				cycle,
				reason: status.reason as AutopilotPauseReason | undefined,
			};
		case "waiting_quota":
			return { kind: "quota", cycle, until: status.quotaResetAt ?? reservation };
		default:
			return reservation !== undefined
				? { kind: "quota", cycle, until: reservation }
				: { kind: "running", cycle, area: status.now?.area };
	}
}

/**
 * An Autopilot tab's approval card stays out of sight for this long: main's approver answers it at once, so the
 * card would only flash. One that is still waiting after it shows, so a failed approver never leaves a silent stall.
 */
export const APPROVAL_GRACE_MS = 3000;

/** Whether an approval card that arrived at `arrivedAt` (epoch ms, unknown = just now) is still held back at `now`. */
export function approvalHeldBack(arrivedAt: number | undefined, now: number): boolean {
	return arrivedAt === undefined || now - arrivedAt < APPROVAL_GRACE_MS;
}
