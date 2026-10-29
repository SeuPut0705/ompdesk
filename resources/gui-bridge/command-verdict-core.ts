/**
 * How one shell command ended, read from the command and stock's answer alone: the one owner of a command's verdict for
 * every surface that judges one (the work card and the work board in the renderer, Autopilot's green check in the
 * bridge). Which checks it runs (`checkKinds`), whether it passed, failed, never ran, was cut off or has not answered
 * (`commandStatus`), whether a non-zero exit only answered a question (`isProbe`), and whether a later run is the same
 * check or chain run again (`coveredBy`, `retriesChain`).
 *
 * Pure and import-free: the renderer imports it, and the bridge loads it in omp (`modes/autopilot-verify.ts`).
 */

export type CheckKind = "test" | "typecheck" | "lint" | "build";

/**
 * How a command's call ended, exclusive: `interrupted` (a stop or the omp process's end cut it off) over `unknown` (no
 * answer yet, or a backgrounded job whose result never reached this transcript) over `refused` (stock or the
 * shared-checkout guard refused it before it ran) over `failed` / `passed` (it ran).
 */
export type CommandStatus = "passed" | "failed" | "refused" | "interrupted" | "unknown";

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

/** Check kinds in the order a summary lists them. */
export const CHECK_KINDS: readonly CheckKind[] = ["test", "typecheck", "lint", "build"];

/**
 * `checkKinds` by command, plain and `grouped`: the work board re-reads every bash call of the session on each
 * streamed event (`lastCheck`) and each work card re-reads its run on every mount, always for the same few commands.
 * Cleared whole at `KINDS_MEMO_MAX` entries, so a long-lived window stays bounded.
 */
const kindsMemo = [new Map<string, readonly CheckKind[]>(), new Map<string, readonly CheckKind[]>()] as const;
const KINDS_MEMO_MAX = 4096;

/**
 * Every kind of check a shell command runs, in `CHECK_KINDS`. `grouped`: a check inside a `( … )` or `{ …; }` group
 * counts too; a run that passed is read so (its group's exit is the list's), while a failed one keeps its kind only
 * when the group does not hide it from the kind a person would name it by. Shared per command: never mutate it.
 */
export function checkKinds(command: string, grouped = false): readonly CheckKind[] {
	const memo = kindsMemo[grouped ? 1 : 0];
	const known = memo.get(command);
	if (known) return known;
	const kinds = new Set<CheckKind>();
	for (const part of splitOutside(stripHeredocs(command), /&&|\|\||;|\n/g)) {
		// A pipeline's first stage is the program; `| tail` only trims its output.
		const stage = (splitOutside(part, PIPE)[0] ?? "").trim();
		const kind = segmentKind((grouped ? stage.replace(/^[({\s]+/, "") : stage).replace(/\s+/g, " "));
		if (kind) kinds.add(kind);
	}
	const found = CHECK_KINDS.filter(kind => kinds.has(kind));
	if (memo.size >= KINDS_MEMO_MAX) memo.clear();
	memo.set(command, found);
	return found;
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

// What stock's bash ends a command with when a stop or the omp process's end cut it off, with no exit to report
// (tools/bash.ts `execute`'s cancelled branch): a leading "[Command cancelled]", a trailing "[Command aborted]", or
// "Command aborted" alone, a capture notice optionally after.
const CUT_OFF = /^\[Command cancelled\]|(?:^|\n\n)(?:\[Command aborted\]|Command aborted)(?:\n\n\[[^\n]*\])?$/;
// The error stock's bash throws for a command that ran and reported no exit (`#throwIfUnfinished`), its details as empty
// as a refusal's.
const MISSING_EXIT = /(?:^|\n\n)Command failed: missing exit status(?:\n\n\[[^\n]*\])?$/;

/** Whether a command's result is stock's notice that a stop or the omp process's end cut the command off. */
export function endsCutOff(resultText: string): boolean {
	return CUT_OFF.test(resultText.trim());
}

/** What stock answered a command's call with, and what this transcript knows about how it ended. */
export interface CommandFacts {
	command: string;
	/** The verdict is a backgrounded job's delivered result, not the call's own answer. */
	delivered?: boolean;
	/** A stop or the omp process's end cut the call off (or its job: an omp restart ended it before it reported). */
	cut: boolean;
	/** No answer yet: the call runs, or a backgrounded job's result has not arrived. */
	pending: boolean;
	/** Stock answered with an error (or the delivered job failed). */
	errored: boolean;
	/** The exit code stock reported (the call's `details.exitCode`, or the delivered job's), else null. */
	exitCode: number | null;
	/** Stock's `details.timedOut`. */
	timedOut?: boolean;
	/** The shared-checkout guard refused the call (`CHECKOUT_REFUSAL_PREFIX`). */
	held?: boolean;
	/** The call's own result text, whole: stock's notices sit at its start and end. */
	resultText: string;
	/** The output's tail the ledger keeps (what a check printed): read for a check that failed with exit 0. */
	output: string;
}

/**
 * The one rule for how a command's call ended. A command that ran reports its exit in the details (stock tools/bash.ts
 * `#buildCompletedResult`: a failed exit's code, a timeout) or, run without one, ends its error with stock's notice
 * (`endsCutOff`, `MISSING_EXIT`); an error with neither is a ToolError stock threw before running the command (its arguments, a
 * blocked command, a missing folder): `refused`, which neither fails nor passes a check and fixes nothing. A command
 * that ran failed when stock flagged it, its exit is not 0, or its check's own output shows failure (`vitest … | tail`
 * hides the code).
 */
export function commandStatus(facts: CommandFacts): CommandStatus {
	if (facts.cut) return "interrupted";
	if (facts.pending) return "unknown";
	if (
		!facts.delivered &&
		facts.errored &&
		(facts.held === true ||
			(facts.exitCode === null &&
				facts.timedOut !== true &&
				!endsCutOff(facts.resultText) &&
				!MISSING_EXIT.test(facts.resultText.trim())))
	)
		return "refused";
	if (facts.errored || (facts.exitCode !== null && facts.exitCode !== 0)) return "failed";
	const kind = checkKind(facts.command);
	return kind !== undefined && outputSaysFailed(kind, facts.output) ? "failed" : "passed";
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
// A pipeline that only reads (`ps aux | grep -c vite`, `git status --porcelain | grep -q x`) asks as its last `grep`
// does; one whose first stage acts (`bun run release | rg -q published`) is judged by that action.
const READS_ONLY =
	/^(?:ps|ls|cat|head|tail|find|echo|printf|env|jq|sort|uniq|wc|lsof|pgrep|grep|egrep|rg|awk|sed\s+-n[A-Za-z]*|git\s+(?:status|log|diff|show|branch|ls-files|ls-tree|rev-parse|worktree\s+list))(?:\s|$)/;
// A stage that writes a file (`> out.txt`, not `2>&1` or `2>/dev/null`) acts, whatever its program.
const WRITES = /(?<![2&])>(?!&)/;
// curl's exit 7 is "could not connect": asked of this computer, the answer is that no server listens there yet (an agent
// polls a dev server it is starting); asked of another host, it is a failure.
const LOOPBACK_CURL = /^curl\s[^<>]*\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?:[:/]|\s|$)/;

// Stock's bash tool runs a leading `cd <dir> &&` as its `cwd` (pi-coding-agent tools/shell-tokenize.ts
// `extractLeadingCdTarget`, which the renderer cannot import): one plain or quoted path, then `&&`.
const LEADING_CD = /^cd[ \t]+("[^"$`\\]*"|'[^']*'|[^\s;&|<>()'"`$\\]+)[ \t]*&&[ \t]*([\s\S]+)$/;

/** A command's leading `cd <dir> &&` as stock runs it: the folder (quotes removed) and the rest; undefined without one. */
export function leadingCd(command: string): { dir: string; rest: string } | undefined {
	const cd = LEADING_CD.exec(command);
	return cd?.[1] && cd[2] ? { dir: cd[1].replace(/^(["'])(.*)\1$/, "$2"), rest: cd[2] } : undefined;
}

/** Whether a command's non-zero exit only answered a question it asked (`which x`, `ls missing`, `curl localhost` not up yet). */
export function isProbe(command: string, exitCode: number | null | undefined, text: string | undefined): boolean {
	if (exitCode !== 1 && exitCode !== 2 && exitCode !== 7) return false;
	// The exit code is the last `;`/newline segment's: that one must be a whole lookup. A leading `cd <dir> &&` is stock's
	// cwd, not a step that could have failed the list.
	const trimmed = command.trim();
	const last = listSegments(LEADING_CD.exec(trimmed)?.[2] ?? trimmed)
		.map(part => part.trim())
		.findLast(Boolean);
	if (!last || (last.match(/["']/g)?.length ?? 0) % 2 !== 0) return false;
	// Quoted text is an argument: a `|` or `;` inside a pattern (`grep "a\|b"`) runs nothing.
	const bare = last.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
	if (exitCode === 7) return LOOPBACK_CURL.test(last) && !CONTROL.test(bare);
	if (exitCode === 1 && !bare.includes("||")) {
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
	if (LISTING.test(last)) {
		const complaints = text?.match(LS_COMPLAINT) ?? [];
		return complaints.length > 0 && complaints.every(line => LS_MISSING.test(line));
	}
	return exitCode === 1 && PROBE.test(last);
}

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

/** Whether a check of `kind` in the command has its output cut by a filter (`tsc | grep a.ts`): its silence proves no pass. */
export function filtersOutput(command: string, kind: CheckKind): boolean {
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
export function passedKinds(command: string, text: string | undefined): CheckKind[] {
	return checkKinds(command, true).filter(kind => {
		const run = checkParts(command, kind);
		return !!run && (run.exitSays || outputSaysPassed(kind, text, command));
	});
}

/** A command that ran, as two runs are compared: the folder it ran in, its text, its output. */
export interface RanCommand {
	/** The folder it ran in, already resolved (a leading `cd <dir> &&` included). */
	dir: string;
	command: string;
	text?: string;
}

// A command with its here-documents and leading `cd <dir> &&` taken out.
function bareText(command: string): string {
	const text = stripHeredocs(command).trim();
	return LEADING_CD.exec(text)?.[2] ?? text;
}

/**
 * Whether a later passing check covers a failed one: the same kind and runner in the same folder, no narrower (every
 * flag, name or script word it has, the failed run had), over every path the failed run named (the same path, a
 * folder holding it, or no path: the whole suite). An agent reruns a failing test file inside a wider run, or a piped
 * type check as the plain one; another package's tests (`packages/b` after `packages/a`) or another test name never
 * covers.
 */
export function coveredBy(failed: RanCommand, fix: RanCommand): boolean {
	const kind = checkKind(failed.command);
	if (!kind || !checkKinds(fix.command, true).includes(kind) || failed.dir !== fix.dir) return false;
	const failedText = bareText(failed.command);
	const fixText = bareText(fix.command);
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

// The `&&`-joined steps of a command that is only such a chain (no list, no `||`).
function chainSteps(command: string): string[] | undefined {
	const text = bareText(command);
	if (listSegments(text).length !== 1 || maskQuoted(text).includes("||")) return undefined;
	return splitOutside(text, /&&/g).map(step => step.trim().replace(/\s+/g, " "));
}

// A script runner's program is its script (`bun run test` is no `bun run deploy`).
const SCRIPT_PROGRAM = /^(?:bun|npm|pnpm|yarn)\b/;

/**
 * Whether a later passing chain is a failed one run again: it redoes the step that may have failed (a command with the
 * same program, its arguments corrected: `git add` without the ignored path) and then runs every step the failed chain
 * ran after it, as typed, ending where it ended. A failed `&&` chain stops at the failing step, so the steps after it
 * never ran; the later chain ran them all. A check keeps `coveredBy`'s rules.
 */
export function retriesChain(failed: RanCommand, fix: RanCommand): boolean {
	const before = chainSteps(failed.command);
	const after = chainSteps(fix.command);
	if (!before || !after || failed.dir !== fix.dir) return false;
	for (let at = 0; at < before.length - 1; at++) {
		const step = before[at] ?? "";
		if (segmentKind(step)) continue;
		const tail = before.slice(at + 1);
		const redone = after.length - tail.length - 1;
		if (redone < 0 || !tail.every((later, index) => later === after[redone + 1 + index])) continue;
		const program = commandProgram(step);
		const again = after[redone] ?? "";
		if (
			program !== undefined &&
			program === commandProgram(again) &&
			(!SCRIPT_PROGRAM.test(program) || step.split(" ", 3).join(" ") === again.split(" ", 3).join(" "))
		)
			return true;
	}
	return false;
}
