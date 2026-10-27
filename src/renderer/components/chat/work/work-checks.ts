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
		// `check:changed` is the repo's own gate: it runs the unit and e2e tests of what changed and prints their counts.
		script: /^(?:test(?::[\w:-]+)?|check:changed)$/,
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
	/^(?:(?:\w+=\S*|npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run|python3?\s+-m|time|env|timeout(?:\s+(?:-[ks]\s*\d+(?:\.\d+)?[smhd]?|-\S+))*\s+\d+(?:\.\d+)?[smhd]?)\s+)+/;
const SCRIPT_RUNNER = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(\S+)/;

/**
 * `text` with the inside of every quoted word blanked (same length, quotes kept) and an escaped character blanked: shell
 * syntax is searched there, so a `;`, `|`, `(` or `&&` in a quoted pattern (`grep "run(user"`) is text, not syntax.
 */
function maskQuoted(text: string): string {
	if (!/["'\\]/.test(text)) return text;
	let masked = "";
	let quote = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index] ?? "";
		if (char === "\\" && quote !== "'" && index + 1 < text.length) {
			masked += "__";
			index++;
		} else if (quote) {
			if (char === quote) {
				quote = "";
				masked += char;
			} else masked += "_";
		} else {
			if (char === '"' || char === "'") quote = char;
			masked += char;
		}
	}
	return masked;
}

/** `text` split at every `separator` (a global pattern) that is shell syntax, not part of a quoted word. */
function splitOutside(text: string, separator: RegExp): string[] {
	const parts: string[] = [];
	let start = 0;
	for (const match of maskQuoted(text).matchAll(separator)) {
		parts.push(text.slice(start, match.index));
		start = (match.index ?? 0) + match[0].length;
	}
	parts.push(text.slice(start));
	return parts;
}

const PIPE = /(?<!\|)\|(?!\|)/g;
const AND_OR = /&&|\|\|/g;
const HEREDOC_OPERATOR = /(?<!<)<<(?!<)-?[ \t]*/;
const HEREDOC_WORD = /^(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_]\w*))/;

/**
 * The command without its here-document bodies and their closing lines: a file written in place (`cat >> a.test.ts
 * <<'EOF' … EOF`) is text, whose quotes, braces and semicolons name no step.
 */
function stripHeredocs(command: string): string {
	if (!command.includes("<<")) return command;
	const lines = command.split("\n");
	const kept: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const operator = HEREDOC_OPERATOR.exec(maskQuoted(line));
		const word = operator && HEREDOC_WORD.exec(line.slice(operator.index + operator[0].length));
		const tag = word?.[1] ?? word?.[2] ?? word?.[3];
		if (!operator || !word || !tag) {
			kept.push(line);
			continue;
		}
		// The operator goes with the body: the command reads the same once the body is gone, and stripping twice is a no-op.
		kept.push(line.slice(0, operator.index) + line.slice(operator.index + operator[0].length + word[0].length));
		while (index + 1 < lines.length && (lines[++index] ?? "").trim() !== tag) {}
	}
	return kept.join("\n");
}

function segmentKind(segment: string): CheckKind | undefined {
	const program = segment.replace(EXEC_WRAPPER, "");
	const script = SCRIPT_RUNNER.exec(program)?.[1];
	for (const check of CHECKS) if (check.tool.test(program) || (script && check.script.test(script))) return check.kind;
	return undefined;
}

const KIND_ORDER: readonly CheckKind[] = ["test", "typecheck", "lint", "build"];

/**
 * Every kind of check a shell command runs, in `KIND_ORDER`. `grouped`: a check inside a `( … )` or `{ …; }` group
 * counts too; a run that passed is read so (its group's exit is the list's), while a failed one keeps its kind only
 * when the group does not hide it from the kind a person would name it by.
 */
export function checkKinds(command: string, grouped = false): CheckKind[] {
	const kinds = new Set<CheckKind>();
	for (const part of splitOutside(stripHeredocs(command), /&&|\|\||;|\n/g)) {
		// A pipeline's first stage is the program; `| tail` only trims its output.
		const stage = (splitOutside(part, PIPE)[0] ?? "").trim();
		const kind = segmentKind((grouped ? stage.replace(/^[({\s]+/, "") : stage).replace(/\s+/g, " "));
		if (kind) kinds.add(kind);
	}
	return KIND_ORDER.filter(kind => kinds.has(kind));
}

/**
 * The check a shell command runs; `undefined` for anything else, and for a compound command that
 * runs checks of two kinds (`npm test && npm run build`): its one exit code cannot say which failed.
 */
export function checkKind(command: string): CheckKind | undefined {
	const kinds = checkKinds(command);
	return kinds.length === 1 ? kinds[0] : undefined;
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
	/** Stock refused the call before running the command (`WorkCommandOutcome.refused`): no check run, no failure. */
	refused?: true;
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
	const live = commands.filter(
		command =>
			!(command.interrupted || command.unknown || command.refused) && checkKinds(command.command, true).length > 0,
	);
	const calls = live.flatMap(command => {
		const failed = commandFailed(command);
		// A failed run names the one kind it runs: which of several failed, only its output could say.
		if (failed) {
			const kind = checkKind(command.command);
			return kind ? [{ command, kind, failed }] : [];
		}
		const kinds = checkKinds(command.command, true);
		// A run that mixes kinds is a pass of each kind its exit or output proves; a type check cut by a filter proves none.
		return (kinds.length === 1 ? kinds : passedKinds(command))
			.filter(kind => !(kind === "typecheck" && filtersOutput(command.command, kind)))
			.map(kind => ({ command, kind, failed: false }));
	});
	let standing = unresolved;
	if (!standing && !calls.some(entry => entry.failed)) standing = new Set();
	if (!standing) {
		const ops = live.map(command => ({ command, op: commandOperation(command) }));
		const left = new Set(
			unresolvedFailures(
				ops.map(({ op }) => op),
				cwd,
			),
		);
		standing = new Set(ops.flatMap(({ command, op }) => (left.has(op) ? [command] : [])));
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

// A command's `;`/newline-separated list, not splitting inside a `{ …; }` or `( … )` group or a quoted word.
function listSegments(command: string): string[] {
	const source = stripHeredocs(command);
	const masked = maskQuoted(source);
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < masked.length; index++) {
		const char = masked[index];
		if (char === "{" || char === "(") depth++;
		else if ((char === "}" || char === ")") && depth > 0) depth--;
		else if ((char === ";" || char === "\n") && depth === 0) {
			parts.push(source.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(source.slice(start));
	return parts;
}
// A segment that only sets up (`cd`, `export`, assignments): look at the one before it.
const NONE = Symbol("setup");
const SHELL_KEYWORD = /^(?:for|while|until|if|then|elif|else|fi|do|done|case|esac|select|function)$/;
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

function segmentProgram(list: string): string | undefined | typeof NONE {
	for (const segment of splitOutside(list, AND_OR)) {
		const words = (splitOutside(segment, PIPE)[0] ?? "")
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
	/** A command's printed output (`CheckInput.text`, kept for failed commands): what says why it exited as it did. */
	text?: string;
}

// What a check's own output says when its exit code does not (`vitest … | tail`, `tsc … | head`: the pipe's last
// stage sets the code). Stock's script runner ends a failed script with `error: script "…" exited with code N`, naming
// the script: it shows the kind's check failed only when it is a script that runs that kind (`check:types`, `test`,
// `check:changed`, `build`), never another step's (`locked`). A type check says `Found N errors` too, and the repo's gate
// `[check:changed] FAILED: <steps>`; a filter that keeps only such a line (`| tail -1`) still shows the failure.
const TS_ERROR = /\berror TS\d{4}\b/;
const FOUND_ERRORS = /\bFound [1-9]\d* errors?\b/;
const SCRIPT_FAILED = /^error: script "([^"]*)" exited with code [1-9]\d*/gm;
const GATE_FAILED = /\[check:changed\] FAILED\b/;
const GATE_PASSED = /\[check:changed\] PASSED\b/;

function outputSaysFailed(kind: CheckKind, text: string | undefined): boolean {
	if (!text) return false;
	const scripts = CHECKS.find(entry => entry.kind === kind)?.script;
	for (const match of text.matchAll(SCRIPT_FAILED)) if (scripts?.test(match[1] ?? "")) return true;
	if (kind === "test") return (testCounts(text).failed ?? 0) > 0 || GATE_FAILED.test(text);
	return kind === "typecheck" && (TS_ERROR.test(text) || FOUND_ERRORS.test(text));
}

function commandFailed(command: CheckInput): boolean {
	if (command.failed || (command.exitCode !== null && command.exitCode !== 0)) return true;
	if (command.interrupted || command.unknown || command.refused || !command.text) return false;
	const kind = checkKind(command.command);
	return kind !== undefined && outputSaysFailed(kind, command.text);
}

export function commandOperation<T extends CheckInput>(command: T): T & OperationCall {
	const failed = commandFailed(command);
	return {
		...command,
		toolName: "bash",
		args: { command: command.command, ...(command.cwd ? { cwd: command.cwd } : {}) },
		...(command.interrupted || command.unknown || command.refused ? {} : { outcome: failed ? "failed" : "passed" }),
		...(failed && command.background ? { reported: true } : {}),
	};
}

// A whole command that only asks: exit 1 is its answer ("not installed", "no such file", "no match"). Any control or
// grouping syntax (`;`, `|`, `&&`, a background `&`, a newline, a subshell, a substitution) runs something else whose
// exit may be the one seen; a redirection's `&` (`2>&1`, `>&2`, `&>`) does not.
const PROBE = /^(?:command\s+-[vV]|which|type|test|\[|grep|rg)\s/;
const CONTROL = /[;|\n()`]|(?<![<>])&(?!>)/;
// A listing exits 1 (macOS) or 2 (GNU) for a missing path, but also for a path it may not read, an unknown option or a
// failed redirection: only one whose every complaint is "No such file or directory" asked and heard "not there"
// (27 Oct 2026: a subagent's closing `ls node_modules/@oh-my-pi` turned a card red). No redirection: its own failure
// exits the same way, and a redirected stderr leaves nothing to read.
const LISTING = /^ls\s(?:2>&1|[^<>])*$/;
const LS_COMPLAINT = /^ls: .*$/gm;
const LS_MISSING = /: No such file or directory\r?$/;
// A command's key by its folder, the session's folder and its raw text: a card's commands are settled again on every
// tool event.
const commandKeys = new Map<string, string>();

function listedMissing(call: OperationCall): boolean {
	const complaints = call.text?.match(LS_COMPLAINT) ?? [];
	return complaints.length > 0 && complaints.every(line => LS_MISSING.test(line));
}

// A pipeline that only reads (`ps aux | grep -c vite`, `git status --porcelain | grep -q x`) asks as its last `grep`
// does; one whose first stage acts (`bun run release | rg -q published`) is judged by that action.
const READS_ONLY =
	/^(?:ps|ls|cat|head|tail|find|echo|printf|env|jq|sort|uniq|wc|lsof|pgrep|grep|egrep|rg|awk|sed\s+-n[A-Za-z]*|git\s+(?:status|log|diff|show|branch|ls-files|ls-tree|rev-parse|worktree\s+list))(?:\s|$)/;
// A stage that writes a file (`> out.txt`, not `2>&1` or `2>/dev/null`) acts, whatever its program.
const WRITES = /(?<![2&])>(?!&)/;
// curl's exit 7 is "could not connect": asked of this computer, the answer is that no server listens there yet (an agent
// polls a dev server it is starting); asked of another host, it is a failure.
const LOOPBACK_CURL = /^curl\s[^<>]*\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?:[:/]|\s|$)/;

function isProbe(call: OperationCall): boolean {
	if (call.toolName !== "bash" || typeof call.args.command !== "string") return false;
	if (call.exitCode !== 1 && call.exitCode !== 2 && call.exitCode !== 7) return false;
	// The exit code is the last `;`/newline segment's: that one must be a whole lookup. A leading `cd <dir> &&` is stock's
	// cwd (`callKeys`), not a step that could have failed the list.
	const command = call.args.command.trim();
	const last = listSegments(LEADING_CD.exec(command)?.[2] ?? command)
		.map(part => part.trim())
		.findLast(Boolean);
	if (!last || (last.match(/["']/g)?.length ?? 0) % 2 !== 0) return false;
	// Quoted text is an argument: a `|` or `;` inside a pattern (`grep "a\|b"`) runs nothing.
	const bare = last.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
	if (call.exitCode === 7) return LOOPBACK_CURL.test(last) && !CONTROL.test(bare);
	if (call.exitCode === 1 && !bare.includes("||")) {
		const stages = bare.split("|").map(stage => stage.trim());
		const final = stages.pop() ?? "";
		if (
			stages.length > 0 &&
			PROBE.test(final) &&
			[...stages, final].every(stage => !CONTROL.test(stage)) &&
			stages.every(
				stage => READS_ONLY.test(stage) && !WRITES.test(stage) && !/\s-(?:exec|execdir|delete|ok)\b/.test(stage),
			)
		)
			return true;
	}
	if (CONTROL.test(bare)) return false;
	if (LISTING.test(last)) return listedMissing(call);
	return call.exitCode === 1 && PROBE.test(last);
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

/** One check a command runs: its runner (`vitest`, `script:check:types`), the paths it names, and every other word. */
interface CheckPart {
	runner: string;
	targets: string[];
	words: string[];
}

const REDIRECT = /^\d*(?:>>?|<|&>)/;
const unquote = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2");
const pathWord = (word: string) => unquote(word).replace(/^\.\//, "").replace(/\/+$/, "");

function checkPart(stage: string, kind: CheckKind): CheckPart | undefined {
	const program = stage.replace(EXEC_WRAPPER, "");
	const check = CHECKS.find(entry => entry.kind === kind);
	const script = SCRIPT_RUNNER.exec(program);
	const byScript = script?.[1] && check?.script.test(script[1]) ? script : null;
	const byTool = byScript ? null : check?.tool.exec(program);
	const head = byScript ? `script:${byScript[1]}` : byTool?.[0].replace(/\s+/g, " ");
	if (!head) return undefined;
	const rest = program.slice((byScript ?? byTool)?.[0].length ?? 0);
	const tokens = rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const targets: string[] = [];
	const words: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (REDIRECT.test(token)) {
			if (/^\d*(?:>>?|<|&>)$/.test(token)) index++;
			continue;
		}
		if (token.startsWith("-")) {
			words.push(token);
			const value = tokens[index + 1];
			// A flag's value (`-t login`, `-p app`) narrows the run like the flag; a path after a flag is a target.
			if (!token.includes("=") && value && !value.startsWith("-") && !/[/.]/.test(value)) {
				words.push(unquote(value));
				index++;
			}
		} else if (/[/.]/.test(token)) targets.push(pathWord(token));
		else words.push(unquote(token));
	}
	return { runner: head, targets, words };
}

// A command with its here-documents and leading `cd <dir> &&` taken out, and the folder it runs in.
function commandText(call: OperationCall, cwd: string): { dir: string; text: string } {
	const [, dir = ""] = (callKeys(call, cwd)[0] ?? "").split("\0");
	const text = stripHeredocs(String(call.args.command)).trim();
	const cd = LEADING_CD.exec(text);
	return { dir, text: cd?.[2] ?? text };
}

/**
 * The checks of `kind` a command runs, or undefined when any step of it is something else than a check or a `cd` (a
 * push after the tests, an `ls` deciding the exit): only a command made of checks can be judged by what it covered.
 * `setupOk`: the output shows the check's own verdict, so steps before it that only prepare it (a test written first,
 * a file put back) are passed over, provided the check is the command's last step.
 * `exitSays`: its exit code is the check's own (one step, or steps joined by `&&`, none piped).
 */
function checkParts(
	command: string,
	kind: CheckKind,
	setupOk = false,
): { parts: CheckPart[]; exitSays: boolean } | undefined {
	const steps = listSegments(command).flatMap(segment => splitOutside(segment, AND_OR));
	const parts: CheckPart[] = [];
	let piped = false;
	let setup = false;
	let closing: CheckKind | undefined;
	for (const step of steps) {
		const pipeline = splitOutside(step, PIPE);
		const stage = (pipeline[0] ?? "")
			.trim()
			.replace(/^\(+|\)+$/g, "")
			.trim()
			.replace(/\s+/g, " ");
		if (!stage || /^cd\s/.test(stage)) continue;
		const stepKind = segmentKind(stage);
		closing = stepKind;
		if (!stepKind) {
			if (!setupOk) return undefined;
			setup = true;
			continue;
		}
		if (stepKind !== kind) continue;
		const part = checkPart(stage, kind);
		if (!part) return undefined;
		parts.push(part);
		if (pipeline.length > 1) piped = true;
	}
	if (parts.length === 0 || (setup && closing !== kind)) return undefined;
	const exitSays = !setup && !piped && listSegments(command).length === 1 && !command.includes("||");
	return { parts, exitSays };
}

// A type check's output cut by a filter that keeps only some lines (`| grep a.ts`, `| tail -3`): what is left cannot
// show that the check passed.
const OUTPUT_FILTER = /^(?:grep|egrep|fgrep|rg|sed|awk|head|tail|cut)(?:\s|$)/;

function filtersOutput(command: string, kind: CheckKind): boolean {
	return listSegments(command).some(segment =>
		splitOutside(segment, AND_OR).some(step => {
			const [first = "", ...rest] = splitOutside(step, PIPE);
			return (
				rest.some(stage => OUTPUT_FILTER.test(stage.trim())) &&
				segmentKind(first.trim().replace(/^\(+/, "").trim().replace(/\s+/g, " ")) === kind
			);
		}),
	);
}

/** Whether a passing check's own output shows it passed, for a run whose exit code a pipe or a later step decided. */
function outputSaysPassed(kind: CheckKind, text: string | undefined, command: string): boolean {
	if (!text || outputSaysFailed(kind, text)) return false;
	if (kind === "test") return (testCounts(text).passed ?? 0) > 0 || GATE_PASSED.test(text);
	return kind === "typecheck" && !filtersOutput(command, kind);
}

/**
 * The kinds a run that mixes kinds proved to have passed (a passing exit that is the check's own, or its output
 * showing it): a list of `biome; tsc; vitest` passes the tests when the tests' own summary says so.
 */
function passedKinds(command: CheckInput): CheckKind[] {
	return checkKinds(command.command, true).filter(kind => {
		const run = checkParts(command.command, kind);
		return !!run && (run.exitSays || outputSaysPassed(kind, command.text, command.command));
	});
}

/**
 * Whether a later passing check covers a failed one: the same kind and runner in the same folder, no narrower (every
 * flag, name or script word it has, the failed run had), over every path the failed run named (the same path, a
 * folder holding it, or no path: the whole suite). An agent reruns a failing test file inside a wider run, or a piped
 * type check as the plain one; another package's tests (`packages/b` after `packages/a`) or another test name never
 * covers.
 */
function coveredBy(failed: OperationCall, fix: OperationCall, cwd: string): boolean {
	const kind = typeof failed.args.command === "string" ? checkKind(failed.args.command) : undefined;
	if (!kind || typeof fix.args.command !== "string" || !checkKinds(fix.args.command, true).includes(kind))
		return false;
	const { dir: failedDir, text: failedText } = commandText(failed, cwd);
	const { dir: fixDir, text: fixText } = commandText(fix, cwd);
	if (failedDir !== fixDir) return false;
	const passed = outputSaysPassed(kind, fix.text, fixText);
	const before = checkParts(failedText, kind, outputSaysFailed(kind, failed.text));
	const after = checkParts(fixText, kind, passed);
	if (!before || !after || !(after.exitSays || passed)) return false;
	return before.parts.every(part =>
		after.parts.some(
			wider =>
				wider.runner === part.runner &&
				wider.words.every(word => part.words.includes(word)) &&
				(wider.targets.length === 0 ||
					(part.targets.length > 0 &&
						part.targets.every(target =>
							wider.targets.some(path => target === path || target.startsWith(path)),
						))),
		),
	);
}

/**
 * The failed calls, in order, split by whether a successful call of the same call (`callKeys`; an edit, of every file
 * it touched), or for a check a later passing check that covers it (`coveredBy`), started after the failure ended: the
 * main agent's success resolves anyone's failure, a subagent's only its own. Probes and inert calls are neither
 * failures nor fixes; a reported failure is never resolved.
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
	const passedChecks: OperationCall[] = [];
	const passedCommands: OperationCall[] = [];
	for (let index = calls.length - 1; index >= first; index--) {
		const call = calls[index];
		if (!counts(call) || (call.outcome === "passed" && !failed.has(family(call)))) continue;
		const keys = callKeys(call, cwd);
		if (call.outcome === "passed") {
			for (const key of keys) fixes.set(key, [...(fixes.get(key) ?? []), call]);
			if (call.toolName === "bash" && typeof call.args.command === "string") {
				passedCommands.push(call);
				if (checkKinds(call.args.command, true).length > 0) passedChecks.push(call);
			}
			continue;
		}
		const fixedBy = (fix: OperationCall) =>
			(fix.agentName === undefined || fix.agentName === call.agentName) &&
			(fix.startTime === undefined || call.endTime === undefined || fix.startTime >= call.endTime);
		const resolved =
			!call.reported &&
			((keys.length > 0 && keys.every(key => fixes.get(key)?.some(fixedBy))) ||
				(call.toolName === "bash" &&
					(passedChecks.some(fix => fixedBy(fix) && coveredBy(call, fix, cwd)) ||
						passedCommands.some(fix => fixedBy(fix) && retriesChain(call, fix, cwd)))));
		(resolved ? recovered : unresolved).unshift(call);
	}
	return { unresolved, recovered };
}

// The `&&`-joined steps of a command that is only such a chain (no list, no `||`), and the folder it runs in.
function chainSteps(call: OperationCall, cwd: string): { dir: string; steps: string[] } | undefined {
	const { dir, text } = commandText(call, cwd);
	if (listSegments(text).length !== 1 || maskQuoted(text).includes("||")) return undefined;
	return { dir, steps: splitOutside(text, /&&/g).map(step => step.trim().replace(/\s+/g, " ")) };
}

// A script runner's program is its script (`bun run test` is no `bun run deploy`).
const SCRIPT_PROGRAM = /^(?:bun|npm|pnpm|yarn)\b/;

/**
 * Whether a later passing chain is a failed one run again: it redoes the step that may have failed (a command with the
 * same program, its arguments corrected: `git add` without the ignored path) and then runs every step the failed chain
 * ran after it, as typed, ending where it ended. A failed `&&` chain stops at the failing step, so the steps after it
 * never ran; the later chain ran them all. A check keeps `coveredBy`'s rules.
 */
function retriesChain(failed: OperationCall, fix: OperationCall, cwd: string): boolean {
	const before = chainSteps(failed, cwd);
	const after = chainSteps(fix, cwd);
	if (!before || !after || before.dir !== after.dir) return false;
	for (let at = 0; at < before.steps.length - 1; at++) {
		const step = before.steps[at] ?? "";
		if (segmentKind(step)) continue;
		const tail = before.steps.slice(at + 1);
		const redone = after.steps.length - tail.length - 1;
		if (redone < 0 || !tail.every((later, index) => later === after.steps[redone + 1 + index])) continue;
		const program = commandProgram(step);
		const again = after.steps[redone] ?? "";
		if (
			program !== undefined &&
			program === commandProgram(again) &&
			(!SCRIPT_PROGRAM.test(program) || step.split(" ", 3).join(" ") === again.split(" ", 3).join(" "))
		)
			return true;
	}
	return false;
}

export function unresolvedFailures<T extends OperationCall>(calls: readonly T[], cwd = ""): T[] {
	return settleFailures(calls, cwd).unresolved;
}
