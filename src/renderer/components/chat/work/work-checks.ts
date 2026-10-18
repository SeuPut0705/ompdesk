/**
 * What a run's commands checked, derived from the commands alone (no model call):
 * which ones were tests, type checks, linters or builds, whether each passed, the
 * test count a runner printed and the first line that names a failure. The work
 * card's head and chips read this, so a finished turn says "tests passed · build
 * failed: <cause>" without opening it.
 */

export type CheckKind = "test" | "typecheck" | "lint" | "build";

/**
 * Per kind, the programs that run it and the package scripts that name it. A program counts only
 * where a command segment runs it (after `npx`, `bunx`, `uv run`, `python -m`, env assignments),
 * so `grep vitest package.json` or `echo 'npm test'` is no test.
 */
const CHECKS: readonly { kind: CheckKind; tool: RegExp; script: RegExp }[] = [
	{
		kind: "test",
		tool: /^(?:vitest|jest|mocha|pytest|rspec|phpunit|ava|playwright\s+test|(?:bun|deno|cargo|go|swift|dotnet|mix|gradle|mvn)\s+test|make\s+test)\b/,
		script: /^test(?::[\w:-]+)?$/,
	},
	{
		kind: "typecheck",
		tool: /^(?:tsc|mypy|pyright|vue-tsc|svelte-check|cargo\s+check|flow\s+check)\b/,
		script: /^(?:check:types|typecheck|type-check|types)$/,
	},
	{
		kind: "lint",
		tool: /^(?:biome|eslint|prettier\s+--check|ruff|flake8|pylint|cargo\s+clippy|golangci-lint|stylelint|shellcheck|rubocop)\b|^node\s+\S*lint[\w-]*\.m?js\b/,
		script: /^lint(?::[\w:-]+)?$/,
	},
	{
		kind: "build",
		tool: /^(?:(?:vite|next|electron-vite|cargo|go|swift|dotnet|gradle|mvn|docker)\s+build|webpack|rollup|esbuild|make|cmake\s+--build|xcodebuild)\b/,
		script: /^(?:build(?::[\w:-]+)?|package:\w+)$/,
	},
];

const EXEC_WRAPPER =
	/^(?:(?:\w+=\S*|npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run|python3?\s+-m|time|env)\s+)+/;
const SCRIPT_RUNNER = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(\S+)/;

function segmentKind(segment: string): CheckKind | undefined {
	const program = segment.replace(EXEC_WRAPPER, "");
	const script = SCRIPT_RUNNER.exec(program)?.[1];
	for (const check of CHECKS) if (check.tool.test(program) || (script && check.script.test(script))) return check.kind;
	return undefined;
}

/**
 * The check a shell command runs; `undefined` for anything else, and for a compound command that
 * runs checks of two kinds (`npm test && npm run build`): its one exit code cannot say which failed.
 */
export function checkKind(command: string): CheckKind | undefined {
	const kinds = new Set<CheckKind>();
	for (const part of command.split(/&&|\|\||;|\n/)) {
		// A pipeline's first stage is the program; `| tail` only trims its output.
		const kind = segmentKind((part.split("|")[0] ?? "").trim().replace(/\s+/g, " "));
		if (kind) kinds.add(kind);
	}
	return kinds.size === 1 ? [...kinds][0] : undefined;
}

const TEST_PASSED = /(\d+)[ \t]+(?:tests?[ \t]+)?pass(?:ed|ing)?\b/gi;
const TEST_FAILED = /(\d+)[ \t]+(?:tests?[ \t]+)?fail(?:ed|ures?|ing)?\b/gi;

function lastCount(text: string, pattern: RegExp): number | undefined {
	let value: number | undefined;
	for (const match of text.matchAll(pattern)) value = Number(match[1]);
	return value;
}

/** The pass/fail counts a test runner printed last (vitest, jest, bun, pytest, cargo, go, mocha). */
export function testCounts(output: string): { passed?: number; failed?: number } {
	const passed = lastCount(output, TEST_PASSED);
	const failed = lastCount(output, TEST_FAILED);
	return { ...(passed !== undefined ? { passed } : {}), ...(failed ? { failed } : {}) };
}

const ERROR_LINE = /(?:\berror\b|\bfailed\b|\bfail\b|[✕✖✗✘×❌]|\bexception\b|\bpanic\b|cannot |not found|\bTS\d{4}\b)/i;
// Runner chrome that names failure without saying what failed.
const NOISE_LINE =
	/^(?:[-=─━\s]+|\d+\s+(?:tests?\s+)?fail(?:ed|ures?)?.*|test files?.*|tests?\s*:.*|error: script ".*" exited.*|exit (?:code|status) \d+|command exited with code \d+|npm err!\s*$|wall time: .*|\[raw output: .*|\[showing .*|\[some lines truncated .*|\[command (?:aborted|cancelled)\])$/i;
const ERROR_LINE_MAX = 140;

/** The first line of a failed command's output that says what went wrong, else its last line. */
export function firstErrorLine(output: string): string | undefined {
	const lines = output
		.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	const hit =
		lines.find(line => ERROR_LINE.test(line) && !NOISE_LINE.test(line)) ??
		lines.findLast(line => !NOISE_LINE.test(line));
	if (!hit) return undefined;
	return hit.length > ERROR_LINE_MAX ? `${hit.slice(0, ERROR_LINE_MAX - 1)}…` : hit;
}

/** One command as the check summary needs it. */
export interface CheckInput {
	command: string;
	failed: boolean;
	exitCode: number | null;
	interrupted?: boolean;
	unknown?: boolean;
	/** The command's printed output (stock's bash result text). */
	text?: string;
	toolCallId?: string;
}

export interface CheckSummary {
	kind: CheckKind;
	/** The last run of this kind decides: a test run that failed and then passed reads as passed. */
	passed: boolean;
	runs: number;
	exitCode: number | null;
	tests?: { passed?: number; failed?: number };
	/** Why the last failing run failed, one line. */
	cause?: string;
	/** The call to open for that failure. */
	toolCallId?: string;
}

const KIND_ORDER: readonly CheckKind[] = ["test", "typecheck", "lint", "build"];

/** Per check kind, the outcome of the last run of it; failed checks first, then the fixed kind order. */
export function summarizeChecks(commands: readonly CheckInput[]): CheckSummary[] {
	const byKind = new Map<CheckKind, CheckSummary>();
	for (const command of commands) {
		if (command.interrupted || command.unknown) continue;
		const kind = checkKind(command.command);
		if (!kind) continue;
		const failed = command.failed || (command.exitCode !== null && command.exitCode !== 0);
		const text = command.text ?? "";
		const tests = kind === "test" ? testCounts(text) : undefined;
		const cause = failed ? firstErrorLine(text) : undefined;
		byKind.set(kind, {
			kind,
			passed: !failed,
			runs: (byKind.get(kind)?.runs ?? 0) + 1,
			exitCode: command.exitCode,
			...(tests && (tests.passed !== undefined || tests.failed !== undefined) ? { tests } : {}),
			...(cause ? { cause } : {}),
			...(command.toolCallId ? { toolCallId: command.toolCallId } : {}),
		});
	}
	return [...byKind.values()].sort(
		(a, b) => Number(a.passed) - Number(b.passed) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
	);
}

/** A failed command that is no check (a script, a `git` call): the card still names its cause. */
export function firstFailure(commands: readonly CheckInput[]): CheckInput | undefined {
	return commands.findLast(command => command.failed && !command.interrupted && !checkKind(command.command));
}
