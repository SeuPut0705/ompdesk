/**
 * What one live trigger source of a routine is and what the orchestrator (triggers.ts) hands it. A source watches
 * one thing (GitHub, a folder, a branch, the sessions of this computer) and calls `fire` with one English line per
 * event; it never starts a run itself, and it owns no timer or watcher after `stop()`.
 */

/** How long a routine's own run still counts as going after it ended: its last writes land after the process exits. */
export const ROUTINE_QUIET_MS = 3_000;

export interface SourceContext {
	/** Start the routine with this line, or keep it for after the running run. False when nothing will run on it. */
	fire(detail: string): boolean;
	/** The routine's own run (or a test run of it) is going now. */
	running(): boolean;
	/** Its own run is going, or ended less than `ROUTINE_QUIET_MS` ago: what changes now are its own work. */
	quiet(): boolean;
	/**
	 * The source cannot watch what it names: one line to the runtime log and a failed run in the routine's history (and
	 * the bot's activity log). Sources call it through `failureReporter`, so a repeating failure is told once.
	 */
	warn(message: string): void;
	/** Where this trigger stood when OMPdesk last ran (marks.ts; JSON the source parses), or undefined: take a baseline. */
	readonly mark: unknown;
	/** Keeps where the trigger stands now for the next launch; save it before firing what it read past the old one. */
	saveMark(mark: unknown): void;
}

export interface RoutineSource {
	/** Stop every timer and watcher; calling it twice, or from inside `fire`, is fine. */
	stop(): void;
	/** The routine's own run just ended (a git source takes the branch as it stands as its new baseline). */
	runEnded?(): void;
}

/**
 * Tells a failure to `warn` once per distinct message and key: the same failure on every poll says nothing more, a
 * different one is told, and a success clears the key so the next failure is told again.
 */
export function failureReporter(warn: (message: string) => void): (key: string, error: unknown | null) => void {
	const told = new Map<string, string>();
	return (key, error) => {
		if (error === null) {
			told.delete(key);
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		if (told.get(key) === message) return;
		told.set(key, message);
		warn(`${key}: ${message}`);
	};
}

const COMMAND_LINES_MAX = 10;
const COMMAND_LINE_CHARS = 100;

/** `3 new commits on main: abc1234 Fix …; def5678 …`: the newest lines (≤10) of `total` new commits. */
export function describeCommits(where: string, total: number, lines: readonly string[]): string {
	const shown = lines.slice(0, COMMAND_LINES_MAX).map(line => clip(line, COMMAND_LINE_CHARS));
	const more = total - shown.length;
	return `${total} new commit${total === 1 ? "" : "s"} on ${where}: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

/** One line of at most `max` characters (code points, never half a surrogate pair), `…` marking a cut. */
export function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	const points = [...line];
	return points.length <= max ? line : `${points.slice(0, max - 1).join("")}…`;
}
