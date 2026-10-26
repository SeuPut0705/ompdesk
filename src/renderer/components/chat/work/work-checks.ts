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
	/** Stock answered with an error and no exit report: it refused the call or the command never reported an exit. */
	noExit?: true;
	/** The command's printed output (stock's bash result text). */
	text?: string;
	toolCallId?: string;
	cwd?: string;
	agentName?: string;
	startTime?: number;
	endTime?: number;
	/** Backgrounded: a failure the transcript also reports (`failedEvents`), which nothing resolves. */
	background?: true;
}

export interface CheckSummary {
	kind: CheckKind;
	/** The kind's last run passed and none of its failures is unresolved (`summarizeChecks`). */
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
 * Per check kind, the outcome of its last run, unless a failed run of that kind is still unresolved: then the last
 * such run, so the chips and the verdict read the same failures. `unresolved` is the caller's own settle of these very
 * commands (`settleFailures`), else they are settled here. Failed checks first, then the fixed kind order.
 */
export function summarizeChecks(
	commands: readonly CheckInput[],
	cwd = "",
	unresolved?: ReadonlySet<CheckInput>,
): CheckSummary[] {
	const calls = commands.flatMap(command => {
		if (command.interrupted || command.unknown || command.noExit) return [];
		const kind = checkKind(command.command);
		return kind ? [{ command, kind, failed: commandFailed(command) }] : [];
	});
	let standing = unresolved;
	if (!standing && !calls.some(entry => entry.failed)) standing = new Set();
	if (!standing) {
		const ops = calls.map(({ command }) => commandOperation(command));
		const left = new Set(unresolvedFailures(ops, cwd));
		standing = new Set(
			calls.flatMap(({ command }, index) => {
				const op = ops[index];
				return op && left.has(op) ? [command] : [];
			}),
		);
	}
	const isStanding = (entry: (typeof calls)[number]) => standing.has(entry.command);
	const byKind = new Map<CheckKind, { entry: (typeof calls)[number]; runs: number }>();
	for (const entry of calls) {
		const seen = byKind.get(entry.kind);
		const keep = seen && isStanding(seen.entry) && !isStanding(entry);
		byKind.set(entry.kind, { entry: keep ? seen.entry : entry, runs: (seen?.runs ?? 0) + 1 });
	}
	return [...byKind.values()]
		.map(({ entry: { command, kind, failed }, runs }): CheckSummary => {
			const text = command.text ?? "";
			const tests = kind === "test" ? testCounts(text) : undefined;
			const cause = failed ? firstErrorLine(text) : undefined;
			return {
				kind,
				passed: !failed,
				runs,
				exitCode: command.exitCode,
				...(tests && (tests.passed !== undefined || tests.failed !== undefined) ? { tests } : {}),
				...(cause ? { cause } : {}),
				...(command.toolCallId ? { toolCallId: command.toolCallId } : {}),
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
 * The program a shell command starts, for naming a failure ("git push", "tsc", "bun test"): the first command after
 * `cd …`/`export …` setup and grouping or negation (`(`, `{`, `!`), past `VAR=…` prefixes, `env`, `sudo` and their
 * flags, and an `npx`/`bunx`/`pnpm dlx` wrapper (the tool it runs). The program's basename, plus its subcommand when
 * that is a plain word (`git push`, `bun run`); a question names what it asks about (`command -v magick`, `which gh`:
 * the program) or itself (`test`, `[`, `grep`). Never a program after it in the chain, which may not have run.
 * `undefined` for an empty command, one that is only setup, and a shell keyword or glob (`for`, `while`, `*.sh`).
 * For a `;`/newline list it names the last command that runs: its exit code is the list's. `timeout <n>` and `time`
 * are skipped like the other wrappers.
 */
export function commandProgram(command: string): string | undefined {
	// The exit code is the last unconditional command's: name the last `;`/newline segment that runs something.
	const lists = listSegments(command);
	for (let list = lists.length - 1; list >= 0; list--) {
		const found = segmentProgram(lists[list] ?? "");
		if (found !== NONE) return found;
	}
	return undefined;
}

// A command's `;`/newline-separated list, not splitting inside a `{ …; }` or `( … )` group.
function listSegments(command: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (char === "{" || char === "(") depth++;
		else if ((char === "}" || char === ")") && depth > 0) depth--;
		else if ((char === ";" || char === "\n") && depth === 0) {
			parts.push(command.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(command.slice(start));
	return parts;
}
// A segment that only sets up (`cd`, `export`, assignments): look at the one before it.
const NONE = Symbol("setup");
const SHELL_KEYWORD = /^(?:for|while|until|if|then|elif|else|fi|do|done|case|esac|select|function)$/;
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

function segmentProgram(list: string): string | undefined | typeof NONE {
	for (const segment of list.split(/&&|\|\|/)) {
		const words = (segment.split("|")[0] ?? "")
			.trim()
			.split(/\s+/)
			.map(word => word.replace(/^[({!]+/, ""))
			.filter(word => word && !/^[)}]+$/.test(word));
		if (words[0] === "command" && /^-[vV]$/.test(words[1] ?? "") && words[2]) return basename(words[2]);
		let index = 0;
		const skip = (): boolean => {
			const word = words[index];
			if (word === undefined) return false;
			if (ASSIGNMENT.test(word) || PRIVILEGE_WRAPPERS.test(word)) {
				index++;
				return true;
			}
			if (word === "timeout") {
				index++;
				while (words[index]?.startsWith("-")) index += /^-[ks]$/.test(words[index] ?? "") ? 2 : 1;
				if (DURATION.test(words[index] ?? "")) index++;
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
		while (skip()) {}
		const first = words[index];
		if (first === undefined || SETUP_COMMANDS.test(first)) continue;
		if (SHELL_KEYWORD.test(first) || /[*?]/.test(first)) return undefined;
		const program = basename(first);
		const next = words[index + 1];
		if (/^(?:which|type)$/.test(program) && next) return basename(next);
		if (/^(?:test|\[\[?|grep|egrep|rg)$/.test(program)) return program;
		return next !== undefined && /^[a-z][\w:-]*$/i.test(next) ? `${program} ${next}` : program;
	}
	return NONE;
}

function basename(path: string): string {
	return path.split("/").at(-1) ?? path;
}

export interface OperationCall {
	toolName: string;
	args: Record<string, unknown>;
	/** How the call settled; none while it runs, when it was cut off or when its result never came. */
	outcome?: "passed" | "failed";
	exitCode?: number | null;
	/** Neither fails nor fixes anything: a read, a search, a wait. */
	inert?: boolean;
	/** A subagent's call: its success resolves only its own failures (an isolated task runs in its own checkout). */
	agentName?: string;
	startTime?: number;
	endTime?: number;
	/** A failure the transcript reports on its own (`failedEvents`): nothing resolves it. */
	reported?: boolean;
}

// What a check's own output says when its exit code does not (`vitest … | tail`, `tsc … | head`: the pipe's last
// stage sets the code).
const TS_ERROR = /\berror TS\d{4}\b/;

function commandFailed(command: CheckInput): boolean {
	if (command.failed || (command.exitCode !== null && command.exitCode !== 0)) return true;
	if (command.interrupted || command.unknown || command.noExit || !command.text) return false;
	const kind = checkKind(command.command);
	if (kind === "test") return (testCounts(command.text).failed ?? 0) > 0;
	if (kind === "typecheck") return TS_ERROR.test(command.text);
	return false;
}

export function commandOperation<T extends CheckInput>(command: T): T & OperationCall {
	const failed = commandFailed(command);
	return {
		...command,
		toolName: "bash",
		args: { command: command.command, ...(command.cwd ? { cwd: command.cwd } : {}) },
		...(command.interrupted || command.unknown || command.noExit ? {} : { outcome: failed ? "failed" : "passed" }),
		...(failed && command.background ? { reported: true } : {}),
	};
}

// A whole command that only asks: exit 1 is its answer ("not installed", "no such file", "no match"). Any control or
// grouping syntax (`;`, `|`, `&&`, a background `&`, a newline, a subshell, a substitution) runs something else whose
// exit may be the one seen; a redirection's `&` (`2>&1`, `>&2`, `&>`) does not.
const PROBE = /^(?:command\s+-[vV]|which|type|test|\[|grep|rg)\s/;
const CONTROL = /[;|\n()`]|(?<![<>])&(?!>)/;
// A command's key by its folder, the session's folder and its raw text: a card's commands are settled again on every
// tool event.
const commandKeys = new Map<string, string>();

function isProbe(call: OperationCall): boolean {
	if (call.exitCode !== 1 || call.toolName !== "bash" || typeof call.args.command !== "string") return false;
	// The exit code is the last `;`/newline segment's: that one must be a whole lookup.
	const last = listSegments(call.args.command)
		.map(part => part.trim())
		.findLast(Boolean);
	if (!last || (last.match(/["']/g)?.length ?? 0) % 2 !== 0) return false;
	return PROBE.test(last) && !CONTROL.test(last);
}

// A hashline header's tag as the model wrote it: `#2C1F`, but also `#?`, `#ANY`, `#`, `#*`, `#2C FB`. Stock's preview
// strips only a 4-hex tag, so a rejected edit's key must drop whatever tag follows the path's last `/`.
const HASHLINE_TAG = /#[^/]*$/;

// Stock's bash tool runs a leading `cd <dir> &&` as its `cwd` (pi-coding-agent tools/shell-tokenize.ts
// `extractLeadingCdTarget`, which the renderer cannot import): one plain or quoted path, then `&&`.
const LEADING_CD = /^cd[ \t]+("[^"$`\\]*"|'[^']*'|[^\s;&|<>()'"`$\\]+)[ \t]*&&[ \t]*([\s\S]+)$/;

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
 * What makes a later call the same call: a command's text (whitespace collapsed) in its folder (stock bash `cwd`, else
 * the session's, then a leading `cd <dir> &&`); each file an edit touches; any other tool, an `xd://` write included,
 * its arguments (the model's intent aside). Empty for an edit without a path: nothing resolves it.
 */
export function callKeys(call: OperationCall, cwd = ""): readonly string[] {
	const { command, cwd: folder } = call.args;
	if (call.toolName === "bash" && typeof command === "string") {
		const base = typeof folder === "string" && folder ? folder : cwd;
		const memo = `${base}\0${cwd}\0${command}`;
		let key = commandKeys.get(memo);
		if (key === undefined) {
			if (commandKeys.size >= 16_384) commandKeys.clear();
			let dir = workFilePathKey(base, cwd);
			let text = command.trim().replace(/\s+/g, " ");
			const cd = LEADING_CD.exec(text);
			if (cd?.[1] && cd[2]) {
				dir = workFilePathKey(cd[1].replace(/^(["'])(.*)\1$/, "$2"), dir);
				text = cd[2];
			}
			key = `bash\0${dir}\0${text}`;
			commandKeys.set(memo, key);
		}
		return [key];
	}
	// Stock's arguments object of a call never changes once the call is made: its keys are read once per folder.
	const cached = argumentKeys.get(call.args);
	if (cached?.cwd === cwd && cached.toolName === call.toolName) return cached.keys;
	const keys =
		TURN_EDIT_TOOLS.includes(call.toolName) && !xdevWriteTarget(call.args)
			? [
					...new Set(
						editArgumentPaths(call.args).map(
							path => `edit\0${workFilePathKey(path.replace(HASHLINE_TAG, ""), cwd)}`,
						),
					),
				]
			: [`${call.toolName}\0${JSON.stringify(canonical(call.args))}`];
	argumentKeys.set(call.args, { cwd, toolName: call.toolName, keys });
	return keys;
}

const argumentKeys = new WeakMap<object, { cwd: string; toolName: string; keys: readonly string[] }>();

/**
 * The failed calls, in order, split by whether a successful call of the same call (`callKeys`; an edit, of every file
 * it touched) started after the failure ended: the main agent's success resolves anyone's failure, a subagent's only
 * its own. Probes and inert calls are neither failures nor fixes; a reported failure is never resolved.
 */
export function settleFailures<T extends OperationCall>(
	calls: readonly T[],
	cwd = "",
): { unresolved: T[]; recovered: T[] } {
	const unresolved: T[] = [];
	const recovered: T[] = [];
	// Only a success after a failure of the same tool can fix anything: a card without failures keys nothing.
	const counts = (call: T | undefined): call is T => !!call?.outcome && !call.inert && !isProbe(call);
	const first = calls.findIndex(call => call.outcome === "failed" && counts(call));
	if (first < 0) return { unresolved, recovered };
	const family = (call: T) =>
		TURN_EDIT_TOOLS.includes(call.toolName) && !xdevWriteTarget(call.args) ? "edit" : call.toolName;
	const failed = new Set(calls.slice(first).flatMap(call => (call.outcome === "failed" ? [family(call)] : [])));
	const fixes = new Map<string, OperationCall[]>();
	for (let index = calls.length - 1; index >= first; index--) {
		const call = calls[index];
		if (!counts(call) || (call.outcome === "passed" && !failed.has(family(call)))) continue;
		const keys = callKeys(call, cwd);
		if (call.outcome === "passed") {
			for (const key of keys) fixes.set(key, [...(fixes.get(key) ?? []), call]);
			continue;
		}
		const fixedBy = (fix: OperationCall) =>
			(fix.agentName === undefined || fix.agentName === call.agentName) &&
			(fix.startTime === undefined || call.endTime === undefined || fix.startTime >= call.endTime);
		const resolved = !call.reported && keys.length > 0 && keys.every(key => fixes.get(key)?.some(fixedBy));
		(resolved ? recovered : unresolved).unshift(call);
	}
	return { unresolved, recovered };
}

export function unresolvedFailures<T extends OperationCall>(calls: readonly T[], cwd = ""): T[] {
	return settleFailures(calls, cwd).unresolved;
}
