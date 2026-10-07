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

/**
 * One row of the live step log. `tool` rows carry the toolCallId and render
 * the step's current label; `thinking` is the reasoning label; `text` is a
 * line of reasoning; `output` is a line of command output.
 */
export interface LiveLogLine {
	kind: "tool" | "thinking" | "text" | "output";
	text: string;
}

/** Lines contributed by one step (a tool call or a reasoning episode). */
export interface LiveLogSegment {
	key: string;
	lines: readonly LiveLogLine[];
}

export type LiveLog = readonly LiveLogSegment[];

function sameLines(a: readonly LiveLogLine[], b: readonly LiveLogLine[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		if (a[index].kind !== b[index].kind || a[index].text !== b[index].text) return false;
	}
	return true;
}

/**
 * Record the current step's lines in the live log. A step re-rendering with
 * the same lines returns `log` unchanged (same reference); a step whose lines
 * changed is replaced and moved to the bottom, so the newest activity is
 * always last; a new step is appended. The log keeps at most `max` lines,
 * dropping the oldest from the top.
 */
export function appendLiveLog(log: LiveLog, segment: LiveLogSegment, max: number): LiveLog {
	const lines = segment.lines.length > max ? segment.lines.slice(-max) : segment.lines;
	const index = log.findIndex(entry => entry.key === segment.key);
	if (index === log.length - 1 && index >= 0 && sameLines(log[index].lines, lines)) return log;
	const next = index < 0 ? [...log] : [...log.slice(0, index), ...log.slice(index + 1)];
	next.push({ key: segment.key, lines });
	let total = 0;
	for (const entry of next) total += entry.lines.length;
	while (total > max) {
		const first = next[0];
		const drop = Math.min(first.lines.length, total - max);
		total -= drop;
		if (drop === first.lines.length) next.shift();
		else next[0] = { key: first.key, lines: first.lines.slice(drop) };
	}
	return next;
}
