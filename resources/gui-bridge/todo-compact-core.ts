/**
 * A todo list that only grows (rules; wiring: todo-compact.ts). Stock's `todo` tool appends, ticks and drops but
 * never folds: a long session that takes round after round ("independent review 20", "perf baseline", next fix…)
 * appended each round to the same list until the work board read 33/38 with one progress segment per task (the
 * owner's report, 3 Nov 2026). Stock's reminders only push the agent to finish open items, and OMPdesk's stale-list
 * rule (todo-stale-core.ts) fires only when a new request meets an old list, never inside one long run.
 *
 * So when an `append` leaves a list longer than `COMPACT_MIN_TASKS` with at least `COMPACT_MIN_CLOSED` items finished,
 * the agent reads one line after that call asking it to fold the finished work into one done item and keep only the
 * open items still worth doing. Only `append`: that is the call that grows a list, and it repeats while the list stays
 * long, so an agent that ignores the line hears it again at its next append and never between.
 *
 * Measured (3 Nov 2026). The owner's 33/38 session (rng-arena, 438 todo calls): while it re-`init`ed per round its
 * list stayed at 2-17 items; after its last `init` (6 items) the next 70 calls held 24 appends and no `init`, `rm` or
 * fold over 28 h, each spawned subagent's work one more row in the same catch-all phase, until 33 done, 2 blocked rows
 * stale to the end and 3 open. `drop` only marks a row abandoned, so nothing shrank the list. The longest lists in this
 * PC's sessions and in the owner's replayed corpus (e2e/fixtures/work-verdict-corpus.json, 16 sessions) held 18 and
 * 16 items, all from one `init` of a playbook's steps plus the task's own items.
 *
 * No omp imports: the GUI's vitest runs it (src/main/bridge-todo-compact.test.ts).
 */

/** Items a list may hold before an append to it asks for a fold: above every list an `init` made in the sessions read (18). */
export const COMPACT_MIN_TASKS = 20;
/** Finished (done or dropped) items a list must hold before a fold is worth asking for. */
export const COMPACT_MIN_CLOSED = 10;

export interface TodoCompactPhase {
	name: string;
	tasks: ReadonlyArray<{ content: string; status: string }>;
}

export interface LongTodo {
	total: number;
	closed: number;
	open: number;
}

const CLOSED: Record<string, true> = { completed: true, abandoned: true };

/** The long list this `todo` result leaves, or undefined to say nothing. `op` is stock's resolved op (`details.op`). */
export function todoCompaction(op: unknown, phases: readonly TodoCompactPhase[]): LongTodo | undefined {
	if (op !== "append") return undefined;
	const tasks = phases.flatMap(phase => phase.tasks);
	const closed = tasks.filter(task => CLOSED[task.status]).length;
	if (tasks.length <= COMPACT_MIN_TASKS || closed < COMPACT_MIN_CLOSED) return undefined;
	return { total: tasks.length, closed, open: tasks.length - closed };
}

/** The line the agent reads after that call, wrapped like stock's own todo reminders. */
export function compactTodoText(long: LongTodo): string {
	return `<system-reminder>
Your todo list now holds ${long.total} items, ${long.closed} of them finished: too long to read at a glance. Fold the finished items with your next todo call: one \`init\` whose first phase holds a single item summing up the finished work (e.g. "Done: review rounds 1-20, perf baseline, 6 fixes"), followed by every unfinished item (${long.open} now: pending, in progress or blocked), verbatim, in their phases. Then mark the summary item done beside your next real call, and \`block\` each item that was blocked again with its blocker as the reason, since \`init\` reopens it. Only finished items fold; an unfinished item leaves the list only when a newer item replaced it, and the summary names that replacement. Never drop an unfinished item for being old. From then on give a new request or round its own phase instead of appending to one catch-all phase, and fold a finished phase the same way before the list grows long again.
</system-reminder>`;
}
