import type { ToolEntry } from "../../stores/tools";

/** The step a collapsed running work group previews under its summary. */
export type LiveStep = { kind: "tool"; id: string } | { kind: "thinking" } | null;

/**
 * Pick the step a running group should show live:
 * 1. the most recently started call still pending/running (ties go to the
 *    later call in the group's order);
 * 2. otherwise live reasoning, when the model is thinking;
 * 3. otherwise the group's last call that has an entry — the step that just
 *    finished, kept on screen until the next one starts.
 */
export function selectLiveStep(
	toolCallIds: readonly string[],
	tools: Pick<ReadonlyMap<string, Pick<ToolEntry, "status" | "startTime">>, "get">,
	thinkingLive: boolean,
): LiveStep {
	let active: { id: string; startTime: number } | null = null;
	let lastKnown: string | null = null;
	for (const id of toolCallIds) {
		const entry = tools.get(id);
		if (!entry) continue;
		lastKnown = id;
		if (entry.status !== "pending" && entry.status !== "running") continue;
		if (!active || entry.startTime >= active.startTime) active = { id, startTime: entry.startTime };
	}
	if (active) return { kind: "tool", id: active.id };
	if (thinkingLive) return { kind: "thinking" };
	return lastKnown ? { kind: "tool", id: lastKnown } : null;
}

export interface WorkStripStep {
	id: string;
	ids: string[];
	startedAt: number;
}

/** Consecutive identical waits are one activity, including in the replay strip. */
export function collapseWaitSteps(
	ids: readonly string[],
	tools: Pick<ReadonlyMap<string, Pick<ToolEntry, "toolName" | "args" | "startTime">>, "get">,
): WorkStripStep[] {
	const steps: WorkStripStep[] = [];
	let previousWait: string | null = null;
	for (const id of ids) {
		const entry = tools.get(id);
		if (!entry) continue;
		const wait = entry.toolName === "wait" ? String(entry.args.i ?? entry.args.reason ?? "") : null;
		const previous = steps.at(-1);
		if (wait !== null && wait === previousWait && previous) {
			previous.id = id;
			previous.ids.push(id);
		} else {
			steps.push({ id, ids: [id], startedAt: entry.startTime });
		}
		previousWait = wait;
	}
	return steps;
}
