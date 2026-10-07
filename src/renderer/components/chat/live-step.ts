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
	tools: ReadonlyMap<string, Pick<ToolEntry, "status" | "startTime">>,
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

/** The last `count` non-blank lines of terminal output, ANSI already stripped by the caller. */
export function tailLines(text: string, count: number): string[] {
	const lines: string[] = [];
	let end = text.length;
	while (end > 0 && lines.length < count) {
		const start = text.lastIndexOf("\n", end - 1);
		const line = text.slice(start + 1, end).trimEnd();
		if (line.trim()) lines.unshift(line);
		end = start < 0 ? 0 : start;
	}
	return lines;
}
