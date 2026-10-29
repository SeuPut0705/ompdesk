/**
 * What the runtime checks of a cycle's own `autopilot end` report, as pure rules (no I/O; ./autopilot.ts feeds
 * them the session's tool events and a few git facts):
 *
 * - the cycle's tool-call ledger (what the agent ran, in order, and whether it worked),
 * - whether a green claim is corroborated by that ledger (a check command ran and passed after the last edit),
 * - a repeated `end` of the same cycle (the first report stands; a report that was refused may be amended),
 * - the commit and the change size the repository itself shows (the agent often leaves the hash out).
 */
import { type CommandStatus, commandStatus } from "../command-verdict-core";
import type { AutopilotChangeStat, AutopilotToolInput, AutopilotVerifyNote, CycleVerify } from "./autopilot-contracts";
import { CHECKOUT_REFUSAL_PREFIX } from "./checkout-peers-contracts";

type EndReport = Extract<AutopilotToolInput, { op: "end" }>;

/** Tools that change files directly (a `bash` command that writes is not seen by this ledger). */
const EDIT_TOOLS: Readonly<Record<string, true>> = { edit: true, write: true, ast_edit: true };

/** One tool call of the cycle, as the ledger keeps it. */
export interface LedgerCall {
	tool: string;
	/** `bash`: the command line. */
	command?: string;
	/**
	 * How it ended: a command by the work card's own rule (`commandStatus`), an edit `passed` or `failed`. A command that
	 * became a background job is `unknown`: its result never reaches this ledger, and it is taken as no failure.
	 */
	status: CommandStatus;
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
	if (EDIT_TOOLS[tool] === true) return { tool, status: isError === true ? "failed" : "passed" };
	if (tool !== "bash") return null;
	const command =
		typeof (args as { command?: unknown } | null)?.command === "string" ? (args as { command: string }).command : "";
	const { content, details } = (result ?? {}) as {
		content?: unknown;
		details?: { async?: { state?: unknown }; exitCode?: unknown; timedOut?: unknown };
	};
	const text = Array.isArray(content)
		? content
				.flatMap(block =>
					typeof (block as { text?: unknown })?.text === "string" ? [(block as { text: string }).text] : [],
				)
				.join("\n")
		: "";
	const status = commandStatus({
		command,
		cut: false,
		pending: details?.async?.state === "running",
		errored: isError === true,
		exitCode: typeof details?.exitCode === "number" ? details.exitCode : null,
		timedOut: details?.timedOut === true,
		held: isError === true && text.trimStart().startsWith(CHECKOUT_REFUSAL_PREFIX),
		resultText: text,
		output: text.slice(-CHECK_OUTPUT_MAX),
	});
	return { tool, command, status };
}

/** As much of a command's output as the work card reads for a check's own verdict (work-view.ts `CHECK_TEXT_MAX`). */
const CHECK_OUTPUT_MAX = 8000;

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
	/** The report was refused: the agent may run the check and `end` again. */
	amendable: boolean;
	/** Green taken from the ledger: the check command whose pass made it green, exactly as it ran. */
	check?: string;
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
	// A check stock refused or a stop cut off never ran to an end: it is no check run.
	const checks = facts.calls
		.map((call, index) => ({ call, index }))
		.filter(
			({ call }) =>
				call.tool === "bash" &&
				call.command !== undefined &&
				call.status !== "refused" &&
				call.status !== "interrupted" &&
				isCheckCommand(call.command, facts.declared),
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
	if (last.call.status === "failed") {
		const command = shorten(last.call.command ?? "");
		return {
			verify: "red",
			note: `Claimed green, but the last check (${command}) failed.`,
			why: { kind: "check_failed", command },
			amendable: true,
		};
	}
	const lastEdit = facts.calls.findLastIndex(call => EDIT_TOOLS[call.tool] === true && call.status === "passed");
	if (lastEdit > last.index) {
		return {
			verify: "skipped",
			note: "Claimed green, but files were edited after the last check ran.",
			why: { kind: "edited_after" },
			amendable: true,
		};
	}
	// The named check is what a land runs again on the merged commit: the declared one when it passed after the last
	// edit, not a narrower run that came after it (a few e2e specs).
	const named = facts.declared ? squash(facts.declared) : "";
	const declaredRun = named
		? checks.findLast(
				({ call, index }) =>
					index > lastEdit && call.status !== "failed" && squash(call.command ?? "").includes(named),
			)
		: undefined;
	const check = (declaredRun ?? last).call.command;
	return { verify: "green", amendable: false, ...(check ? { check } : {}) };
}

/** The part of a first report a repeated `end` may add to: follow-ups, resolved ones, children, ship and commit the first left out. */
export function mergeRepeatedEnd(first: EndReport, again: EndReport): EndReport {
	const followups = [...new Set([...(first.followups ?? []), ...(again.followups ?? [])])];
	const resolved = [...new Set([...(first.resolved ?? []), ...(again.resolved ?? [])])];
	return {
		...first,
		...(followups.length > 0 ? { followups } : {}),
		...(resolved.length > 0 ? { resolved } : {}),
		...(first.children?.length ? {} : again.children?.length ? { children: again.children } : {}),
		...(first.ship === undefined && again.ship !== undefined ? { ship: again.ship } : {}),
		...(first.commit === undefined && again.commit !== undefined ? { commit: again.commit } : {}),
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
