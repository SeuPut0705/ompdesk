/**
 * What the runtime checks of a cycle's own `autopilot end` report, as pure rules (no I/O; ./autopilot.ts feeds
 * them the session's tool events and a few git facts):
 *
 * - the cycle's tool-call ledger (what the agent ran, in order, and whether it worked),
 * - whether a green claim is corroborated by that ledger (a check command ran and passed after the last edit),
 * - a repeated `end` of the same cycle (the first report stands; a report that was refused may be amended),
 * - the commit and the change size the repository itself shows (the agent often leaves the hash out).
 */
import type { AutopilotChangeStat, AutopilotToolInput, AutopilotVerifyNote, CycleVerify } from "./autopilot-contracts";

type EndReport = Extract<AutopilotToolInput, { op: "end" }>;

/** Tools that change files directly (a `bash` command that writes is not seen by this ledger). */
const EDIT_TOOLS: Readonly<Record<string, true>> = { edit: true, write: true, ast_edit: true };

/** One tool call of the cycle, as the ledger keeps it. */
export interface LedgerCall {
	tool: string;
	/** `bash`: the command line. */
	command?: string;
	/** Not an error result. A call that is still a background job has no verdict yet: `ok` with `background`. */
	ok: boolean;
	background: boolean;
}

const RUNNER_PREFIX = String.raw`(?:bun|npm|pnpm|yarn|deno)(?:\s+run)?`;
const CHECK_WORD = String.raw`[\w:./@-]*(?:test|check|lint|typecheck|tsc|vitest|jest|playwright|verify|ci)[\w:.-]*`;
const CHECK_SEGMENT: readonly RegExp[] = [
	new RegExp(`^${RUNNER_PREFIX}\\s+${CHECK_WORD}`),
	/^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:vitest|jest|mocha|tsc|eslint|biome|playwright|ruff|mypy|pyright|prettier\s+--check)\b/,
	/^(?:python3?\s+-m\s+)?(?:pytest|unittest|tox|nox|mypy|pyright)\b/,
	/^ruff\s+(?:check|format\s+--check)\b/,
	/^cargo\s+(?:test|check|clippy|nextest)\b/,
	/^go\s+(?:test|vet)\b/,
	/^(?:make|just|task)\s+[\w:-]*(?:test|check|lint|verify|ci)\b/,
	/^(?:vitest|jest|mocha|tsc|eslint|rspec|phpunit|rubocop)\b/,
	/^biome\s+(?:check|lint|ci)\b/,
	/^(?:dotnet|swift|flutter|dart|mix)\s+test\b/,
	/^(?:mvn|\.\/mvnw)\s+(?:\S+\s+)*(?:test|verify)\b/,
	/^(?:gradle|\.\/gradlew)\s+(?:\S+\s+)*(?:test|check)\b/,
	/^zig\s+(?:build\s+)?test\b/,
	/^(?:\.\/)?scripts?\/\S*(?:test|check|verify|lint)\S*/,
];

/** The simple commands of a shell line: split on newlines, `&&`, `||`, `;` and `|`; leading `VAR=x` words and `time` dropped. */
function segments(command: string): string[] {
	return command
		.split(/\n|&&|\|\||;|\|/)
		.map(part => part.trim().replace(/^(?:time\s+|(?:\w+=\S*\s+)+)/, ""))
		.filter(Boolean);
}

function squash(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether a `bash` command line runs a check: a known test/lint/type-check runner at the start of one of its
 * simple commands (through `bun run locked --` and `cd dir &&` wrappers), or the command the agent said it ran.
 */
export function isCheckCommand(command: string, declared?: string): boolean {
	const named = declared ? squash(declared) : "";
	if (named && squash(command).includes(named)) return true;
	return segments(command).some(segment => {
		const bare = segment.replace(
			/^(?:bun\s+run\s+locked|bun\s+scripts\/build-lock\.ts)(?:\s+--(?:kind|chunk)\s+\S+)*(?:\s+--)?(?:\s+--(?:kind|chunk)\s+\S+)*(?:\s+--)?\s+/,
			"",
		);
		return CHECK_SEGMENT.some(rule => rule.test(bare));
	});
}

/** The ledger entry of a finished tool call, or null for tools the ledger does not follow. */
export function ledgerCall(
	tool: string,
	args: unknown,
	result: unknown,
	isError: boolean | undefined,
): LedgerCall | null {
	if (EDIT_TOOLS[tool] === true) return { tool, ok: isError !== true, background: false };
	if (tool !== "bash") return null;
	const command =
		typeof (args as { command?: unknown } | null)?.command === "string" ? (args as { command: string }).command : "";
	const details = (result as { details?: { async?: { state?: unknown } } } | null)?.details;
	return { tool, command, ok: isError !== true, background: details?.async?.state === "running" };
}

export interface VerifyFacts {
	claimed: CycleVerify;
	calls: readonly LedgerCall[];
	/** The cycle left something behind: a commit, a dirty tree or an edit call. */
	changed: boolean;
	/** The check command the agent said it ran, if it said. */
	declared?: string;
}

export interface VerifyVerdict {
	verify: CycleVerify;
	/** Why the claim was not taken as it was: the sentence the agent is told, and the same as data for the screen. */
	note?: string;
	why?: AutopilotVerifyNote;
	/** The report was refused: the agent may run the check and call `end` again. */
	amendable: boolean;
}

function shorten(command: string): string {
	const one = squash(command);
	return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

/**
 * Green is taken only when the ledger shows it: after the cycle's last edit, a check command ran, and the last check
 * did not fail. Without any check the claim becomes `skipped`; a last check that failed makes it `red`. A claim that
 * is not green, or a cycle that changed nothing, is taken as it is.
 */
export function judgeVerify(facts: VerifyFacts): VerifyVerdict {
	if (facts.claimed !== "green" || !facts.changed) return { verify: facts.claimed, amendable: false };
	const checks = facts.calls
		.map((call, index) => ({ call, index }))
		.filter(
			({ call }) =>
				call.tool === "bash" && call.command !== undefined && isCheckCommand(call.command, facts.declared),
		);
	const last = checks.at(-1);
	if (!last) {
		return {
			verify: "skipped",
			note: "Claimed green, but no check command ran this cycle.",
			why: { kind: "no_check" },
			amendable: true,
		};
	}
	if (!last.call.ok && !last.call.background) {
		const command = shorten(last.call.command ?? "");
		return {
			verify: "red",
			note: `Claimed green, but the last check (${command}) failed.`,
			why: { kind: "check_failed", command },
			amendable: true,
		};
	}
	const lastEdit = facts.calls.findLastIndex(call => EDIT_TOOLS[call.tool] === true && call.ok);
	if (lastEdit > last.index) {
		return {
			verify: "skipped",
			note: "Claimed green, but files were edited after the last check ran.",
			why: { kind: "edited_after" },
			amendable: true,
		};
	}
	return { verify: "green", amendable: false };
}

/** The part of a first report a repeated `end` may add to: follow-ups, children, ship and commit the first left out. */
export function mergeRepeatedEnd(first: EndReport, again: EndReport): EndReport {
	const followups = [...new Set([...(first.followups ?? []), ...(again.followups ?? [])])];
	return {
		...first,
		...(followups.length > 0 ? { followups } : {}),
		...(first.children?.length ? {} : again.children?.length ? { children: again.children } : {}),
		...(first.ship === undefined && again.ship !== undefined ? { ship: again.ship } : {}),
		...(first.commit === undefined && again.commit !== undefined ? { commit: again.commit } : {}),
		...(first.backlogId === undefined && again.backlogId !== undefined ? { backlogId: again.backlogId } : {}),
	};
}

export interface CommitFacts {
	/** What the agent reported (may be absent or wrong). */
	claimed?: string;
	/** The claimed hash names a commit that is in the branch's history. */
	claimedKnown: boolean;
	/** `git rev-parse --short HEAD` at `end`. */
	head?: string;
	/** HEAD moved since the turn began. */
	moved: boolean;
}

/** The commit a cycle record carries: a claimed hash that exists stays, otherwise the commit the repository shows, else none. */
export function reconcileCommit(facts: CommitFacts): string | undefined {
	if (facts.claimed && facts.claimedKnown) return facts.claimed;
	return facts.moved ? facts.head : undefined;
}

const DOC_FILE =
	/(?:^|\/)(?:docs?|documentation)\/|\.(?:md|mdx|markdown|txt|rst|adoc)$|(?:^|\/)(?:README|CHANGELOG|LICENSE)[^/]*$/i;

/** `git diff --numstat` output as a change size; null when it lists nothing. Binary files count as a file with no lines. */
export function parseNumstat(text: string, commits: number): AutopilotChangeStat | null {
	let files = 0;
	let added = 0;
	let removed = 0;
	let docs = 0;
	for (const line of text.split("\n")) {
		const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
		if (!match) continue;
		files++;
		added += match[1] === "-" ? 0 : Number(match[1]);
		removed += match[2] === "-" ? 0 : Number(match[2]);
		if (DOC_FILE.test(match[3])) docs++;
	}
	if (files === 0) return null;
	return { files, added, removed, commits, ...(docs === files ? { docOnly: true } : {}) };
}

/** The stop steer asks the turn in flight for its `end`; a cycle that has already reported needs none (a second `end` is only an extra model round). */
export function shouldSteerStop(facts: { streaming: boolean; reported: boolean }): boolean {
	return facts.streaming && !facts.reported;
}
