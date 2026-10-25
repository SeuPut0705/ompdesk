/**
 * What a run's commands checked, derived from the commands alone (no model call):
 * which ones were tests, type checks, linters or builds, whether each passed, the
 * test count a runner printed and the first line that names a failure. The work
 * card's head and chips read this, so a finished turn says "tests passed · build
 * failed: <cause>" without opening it.
 */
import { TURN_EDIT_TOOLS } from "../../../../shared/turn-edits";
import { xdevWriteTarget } from "../../../lib/xdev";
import { editArgumentPaths, workFilePathKey } from "../../tools/edit-args";

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
	cwd?: string;
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

/**
 * Per check kind, the outcome of its last run, unless a failed run of that kind is still unresolved
 * (`unresolvedFailures`): then the last such run, so the chips and the verdict read the same failures. Failed checks
 * first, then the fixed kind order.
 */
export function summarizeChecks(commands: readonly CheckInput[], cwd = ""): CheckSummary[] {
	const calls = commands.flatMap(command => {
		const kind = checkKind(command.command);
		const call = commandOperation(command);
		return kind && call.outcome ? [{ ...call, kind }] : [];
	});
	const standing = new Set(unresolvedFailures(calls, cwd));
	const byKind = new Map<CheckKind, { call: (typeof calls)[number]; runs: number }>();
	for (const call of calls) {
		const seen = byKind.get(call.kind);
		const unresolved = seen && standing.has(seen.call) && !standing.has(call);
		byKind.set(call.kind, { call: unresolved ? seen.call : call, runs: (seen?.runs ?? 0) + 1 });
	}
	return [...byKind.values()]
		.map(({ call, runs }): CheckSummary => {
			const failed = call.outcome === "failed";
			const text = call.text ?? "";
			const tests = call.kind === "test" ? testCounts(text) : undefined;
			const cause = failed ? firstErrorLine(text) : undefined;
			return {
				kind: call.kind,
				passed: !failed,
				runs,
				exitCode: call.exitCode,
				...(tests && (tests.passed !== undefined || tests.failed !== undefined) ? { tests } : {}),
				...(cause ? { cause } : {}),
				...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
			};
		})
		.sort((a, b) => Number(a.passed) - Number(b.passed) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

const RUNNER_WRAPPERS = /^(?:npx|bunx|uvx|pnpx)$/;
const SUBCOMMAND_WRAPPERS = /^(?:pnpm|yarn|npm|bun)$/;
const PRIVILEGE_WRAPPERS = /^(?:env|sudo|time|nohup|command|exec|nice)$/;
const SETUP_COMMANDS = /^(?:cd|export|set|source|\.|pushd|popd|unset|umask)$/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * The program a shell command really runs, for naming a failure ("git push", "tsc", "bun test"): the first command
 * after `cd …`/`export …` setup, past `VAR=…` prefixes, `env`, `sudo` and their flags, and an `npx`/`bunx`/`pnpm dlx`
 * wrapper (the tool it runs). The program's basename, plus its subcommand when that is a plain word (`git push`,
 * `bun run`). `undefined` for an empty command.
 */
export function commandProgram(command: string): string | undefined {
	let probe: string | undefined;
	for (const segment of command.split(/&&|\|\||;|\n/)) {
		// Grouping and negation (`(…)`, `{ …; }`, `!`) are not the program.
		const words = (segment.split("|")[0] ?? "")
			.trim()
			.split(/\s+/)
			.map(word => word.replace(/^[({!]+/, ""))
			.filter(word => word && !/^[)}]+$/.test(word));
		let index = 0;
		const skip = (): boolean => {
			const word = words[index];
			if (word === undefined) return false;
			if (ASSIGNMENT.test(word) || PRIVILEGE_WRAPPERS.test(word)) {
				index++;
				return true;
			}
			if (word.startsWith("-") && index > 0) {
				index++;
				return true;
			}
			if (
				RUNNER_WRAPPERS.test(word) ||
				(SUBCOMMAND_WRAPPERS.test(word) && /^(?:dlx|exec|x)$/.test(words[index + 1] ?? ""))
			) {
				index += RUNNER_WRAPPERS.test(word) ? 1 : 2;
				return true;
			}
			return false;
		};
		// A question asked before the work (`command -v x &&`, `test -f x &&`) names the work, if any follows it.
		if (words[0] === "command" && /^-[vV]$/.test(words[1] ?? "")) {
			probe ??= "command";
			continue;
		}
		while (skip()) {}
		const first = words[index];
		if (first === undefined || SETUP_COMMANDS.test(first)) continue;
		const program = first.split("/").at(-1) ?? first;
		if (/^(?:test|\[\[?|which|type|grep|rg)$/.test(program)) {
			probe ??= program;
			continue;
		}
		const next = words[index + 1];
		return next !== undefined && /^[a-z][\w:-]*$/i.test(next) ? `${program} ${next}` : program;
	}
	return probe;
}

export interface OperationCall {
	toolName: string;
	args: Record<string, unknown>;
	/** How the call settled; none while it runs, when it was cut off or when its result never came. */
	outcome?: "passed" | "failed";
	exitCode?: number | null;
	/** Neither fails nor fixes anything: a read, a search, a wait. */
	inert?: boolean;
	agentName?: string;
}

export function commandOperation<T extends CheckInput>(command: T): T & OperationCall {
	const failed = command.failed || (command.exitCode !== null && command.exitCode !== 0);
	return {
		...command,
		toolName: "bash",
		args: { command: command.command, ...(command.cwd ? { cwd: command.cwd } : {}) },
		...(command.interrupted || command.unknown ? {} : { outcome: failed ? "failed" : "passed" }),
	};
}

// A whole command that only asks: exit 1 is its answer ("not installed", "no such file", "no match"). Any control or
// grouping syntax (`;`, `|`, `&&`, a background `&`, a newline, a subshell, a substitution) runs something else whose
// exit may be the one seen; a redirection's `&` (`2>&1`, `>&2`, `&>`) does not.
const PROBE = /^(?:command\s+-[vV]|which|type|test|\[|grep|rg)\s/;
const CONTROL = /[;|\n()`]|(?<![<>])&(?!>)/;
// Whitespace-collapsed command text by its raw text: a card's commands are settled again on every tool event.
const normalized = new Map<string, string>();

function commandText(command: string): string {
	let text = normalized.get(command);
	if (text === undefined) {
		if (normalized.size >= 4096) normalized.clear();
		text = command.trim().replace(/\s+/g, " ");
		normalized.set(command, text);
	}
	return text;
}

function isProbe(call: OperationCall): boolean {
	if (call.exitCode !== 1 || call.toolName !== "bash" || typeof call.args.command !== "string") return false;
	const command = call.args.command.trim();
	return PROBE.test(command) && !CONTROL.test(command);
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.filter(key => key !== "i" && key !== "intent")
			.sort()
			.map(key => [key, canonical((value as Record<string, unknown>)[key])]),
	);
}

/**
 * What makes a later call the same call: a command's text (whitespace collapsed) in its folder; each file an edit
 * touches; any other tool, an `xd://` write included, its arguments (the model's intent aside). Empty for an edit
 * without a path: nothing resolves it.
 */
export function callKeys(call: OperationCall, cwd = ""): readonly string[] {
	const { command, cwd: folder } = call.args;
	if (call.toolName === "bash" && typeof command === "string") {
		const dir = typeof folder === "string" && folder ? workFilePathKey(folder, cwd) : "";
		return [`bash\0${dir}\0${commandText(command)}`];
	}
	if (TURN_EDIT_TOOLS.includes(call.toolName) && !xdevWriteTarget(call.args)) {
		return [...new Set(editArgumentPaths(call.args).map(path => `edit\0${workFilePathKey(path, cwd)}`))];
	}
	return [`${call.toolName}\0${JSON.stringify(canonical(call.args))}`];
}

/**
 * The failed calls, in order, split by whether a later successful call was the same call (`callKeys`; an edit, of
 * every file it touched). Probes and inert calls are neither failures nor fixes.
 */
export function settleFailures<T extends OperationCall>(
	calls: readonly T[],
	cwd = "",
): { unresolved: T[]; recovered: T[] } {
	const unresolved: T[] = [];
	const recovered: T[] = [];
	// Only a success after the first failure can fix anything: a card without failures keys nothing.
	const first = calls.findIndex(call => call.outcome === "failed" && !call.inert && !isProbe(call));
	if (first < 0) return { unresolved, recovered };
	const fixed = new Set<string>();
	for (let index = calls.length - 1; index >= first; index--) {
		const call = calls[index];
		if (!call?.outcome || call.inert || isProbe(call)) continue;
		const keys = callKeys(call, cwd);
		if (call.outcome === "passed") for (const key of keys) fixed.add(key);
		else if (keys.length && keys.every(key => fixed.has(key))) recovered.unshift(call);
		else unresolved.unshift(call);
	}
	return { unresolved, recovered };
}

export function unresolvedFailures<T extends OperationCall>(calls: readonly T[], cwd = ""): T[] {
	return settleFailures(calls, cwd).unresolved;
}
