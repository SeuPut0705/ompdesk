/**
 * The Autopilot hard limits as pure rules, shared by three callers: the bridge's `tool_call` guard
 * (autopilot.ts), main's approver (a remaining approval card is Denied when its text violates a ban)
 * and main's post-cycle audit. Nothing here imports anything (main imports this file directly).
 *
 * What it reads is the tool call itself: `bash` is split into simple commands (quotes, `$(...)`,
 * backticks, `sh -c`, heredocs, `env`/`xargs`/`find -exec` wrappers) and each one is classified;
 * file tools are path-checked; the `github` tool is allow-listed by operation.
 *
 * Known limits (the audit in main is the required second defence): obfuscation a tokenizer cannot see
 * (variables holding a command, `eval` of a built string, inline code of an interpreter beyond the
 * banned phrases we scan for, shell aliases/functions defined elsewhere, symlinks out of the worktree).
 */
import type { AutopilotShipLevel } from "./autopilot-contracts";

export interface GuardInput {
	/** The hook's tool name, without any prefix (`bash`, `edit`, `github`, ...). */
	toolName: string;
	input: unknown;
	/** The worktree root the run (or the child) lives in. */
	root: string;
	shipLevel: AutopilotShipLevel;
	/** A verified `ship release` request or a due release: the release scope is open for this turn. */
	oneShotRelease: boolean;
	role: "parent" | "child";
	/** The configured remote NAME (default `origin`). */
	remote?: string;
	/** The default branch a release pushes `HEAD:<it>` to (default `main`). */
	defaultBranch?: string;
}

export interface GuardDecision {
	block: boolean;
	reason?: string;
}

export interface BanScanOptions {
	/** Without a root the path checks are skipped (an approver card carries no worktree). */
	root?: string;
	shipLevel?: AutopilotShipLevel;
	oneShotRelease?: boolean;
	role?: "parent" | "child";
	remote?: string;
	defaultBranch?: string;
}

const ALLOW: GuardDecision = { block: false };

function deny(reason: string): GuardDecision {
	return { block: true, reason: `Blocked by autopilot: ${reason}. Record a follow-up and pick another item.` };
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

function slashes(value: string): string {
	return value.replace(/\\/g, "/");
}

/** Collapses `.`/`..`/`//`; an absolute result keeps its drive/root. Relative input is resolved against `base`. */
export function normalizePath(value: string, base: string): string {
	const raw = slashes(value);
	const joined = /^([a-zA-Z]:)?\//.test(raw) ? raw : `${slashes(base).replace(/\/+$/, "")}/${raw}`;
	const drive = /^[a-zA-Z]:/.test(joined) ? joined.slice(0, 2).toLowerCase() : "";
	const rest = drive ? joined.slice(2) : joined;
	const out: string[] = [];
	for (const part of rest.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `${drive}/${out.join("/")}`;
}

export function isInside(target: string, root: string): boolean {
	const t = target.toLowerCase();
	const r = root.replace(/\/+$/, "").toLowerCase();
	return t === r || t.startsWith(`${r}/`);
}

function hasGitSegment(path: string): boolean {
	return path.split("/").includes(".git");
}

const SCRATCH_PREFIXES = ["/dev/", "/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

function isScratch(path: string): boolean {
	return SCRATCH_PREFIXES.some(prefix => path.startsWith(prefix)) || path === "/dev/null";
}

interface Resolved {
	path?: string;
	/** `~` / `$VAR` / a substitution: cannot be resolved here. */
	unresolvable: boolean;
}

function resolveWord(word: string, cwd: string): Resolved {
	if (word === "~" || word.startsWith("~/") || /^~[a-zA-Z]/.test(word)) return { unresolvable: true };
	if (/[$`]/.test(word)) return { unresolvable: true };
	return { path: normalizePath(word, cwd), unresolvable: false };
}

/** Why a file path must not be written, or undefined. */
function writePathProblem(word: string, cwd: string, root: string, allowScratch: boolean): string | undefined {
	if (word === "") return undefined;
	const resolved = resolveWord(word, cwd);
	if (resolved.unresolvable || !resolved.path) return `cannot verify that "${word}" stays inside the worktree`;
	if (allowScratch && isScratch(resolved.path)) return undefined;
	if (!isInside(resolved.path, root)) return `"${word}" is outside your worktree`;
	if (hasGitSegment(resolved.path.slice(root.length))) return `"${word}" is inside .git`;
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Shell parsing: a command line -> simple commands
// ---------------------------------------------------------------------------------------------

interface Simple {
	argv: string[];
	redirects: string[];
	heredocs: string[];
}

const MAX_DEPTH = 6;
const TOO_DEEP = "\u0000too-deep";
const OPERATOR_CHARS = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

function matchParen(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") i++;
		else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end === -1) return src.length;
			i = end;
		} else if (c === '"') {
			for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
		} else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return src.length;
}

function parseShell(src: string, depth: number): Simple[] {
	if (depth > MAX_DEPTH) return [{ argv: [TOO_DEEP], redirects: [], heredocs: [] }];
	const out: Simple[] = [];
	let current: Simple = { argv: [], redirects: [], heredocs: [] };
	const pendingHeredocs: Array<{ delimiter: string; strip: boolean; target: Simple }> = [];
	let i = 0;
	const n = src.length;

	const endCommand = () => {
		if (current.argv.length > 0 || current.redirects.length > 0 || current.heredocs.length > 0) out.push(current);
		current = { argv: [], redirects: [], heredocs: [] };
	};
	const substitution = (inner: string) => {
		for (const nested of parseShell(inner, depth + 1)) out.push(nested);
	};

	const readWord = (): string => {
		let word = "";
		while (i < n) {
			const c = src[i];
			if (c === "\\") {
				if (src[i + 1] === "\n") {
					i += 2;
					continue;
				}
				word += src[i + 1] ?? "";
				i += 2;
				continue;
			}
			if (c === "'") {
				const end = src.indexOf("'", i + 1);
				const stop = end === -1 ? n : end;
				word += src.slice(i + 1, stop);
				i = stop + 1;
				continue;
			}
			if (c === '"') {
				i++;
				while (i < n && src[i] !== '"') {
					if (src[i] === "\\") {
						word += src[i + 1] ?? "";
						i += 2;
					} else if (src[i] === "$" && src[i + 1] === "(") {
						const end = matchParen(src, i + 1);
						substitution(src.slice(i + 2, end));
						word += "$()";
						i = end + 1;
					} else if (src[i] === "`") {
						const end = src.indexOf("`", i + 1);
						const stop = end === -1 ? n : end;
						substitution(src.slice(i + 1, stop));
						word += "$()";
						i = stop + 1;
					} else {
						word += src[i];
						i++;
					}
				}
				i++;
				continue;
			}
			if (c === "$" && src[i + 1] === "(") {
				const end = matchParen(src, i + 1);
				substitution(src.slice(i + 2, end));
				word += "$()";
				i = end + 1;
				continue;
			}
			if ((c === "<" || c === ">") && src[i + 1] === "(") {
				const end = matchParen(src, i + 1);
				substitution(src.slice(i + 2, end));
				word += "$()";
				i = end + 1;
				continue;
			}
			if (c === "`") {
				const end = src.indexOf("`", i + 1);
				const stop = end === -1 ? n : end;
				substitution(src.slice(i + 1, stop));
				word += "$()";
				i = stop + 1;
				continue;
			}
			if (OPERATOR_CHARS.has(c)) break;
			word += c;
			i++;
		}
		return word;
	};

	const readHeredocBodies = () => {
		for (const pending of pendingHeredocs.splice(0)) {
			const lines: string[] = [];
			while (i < n) {
				let end = src.indexOf("\n", i);
				if (end === -1) end = n;
				const line = src.slice(i, end);
				i = Math.min(end + 1, n);
				if ((pending.strip ? line.replace(/^\t+/, "") : line) === pending.delimiter) break;
				lines.push(line);
			}
			pending.target.heredocs.push(lines.join("\n"));
		}
	};

	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t") {
			i++;
			continue;
		}
		if (c === "\n") {
			i++;
			if (pendingHeredocs.length > 0) {
				// The heredoc belongs to the command of the line that just ended.
				endCommand();
				readHeredocBodies();
			} else endCommand();
			continue;
		}
		if (c === "#" && (i === 0 || /\s/.test(src[i - 1] ?? " ")) && current.argv.length === 0) {
			// A comment runs to the end of the line.
			while (i < n && src[i] !== "\n") i++;
			continue;
		}
		if (c === ";" || c === "(" || c === ")") {
			endCommand();
			i++;
			continue;
		}
		if (c === "&" && src[i + 1] !== ">") {
			endCommand();
			i += src[i + 1] === "&" ? 2 : 1;
			continue;
		}
		if (c === "|") {
			endCommand();
			i += src[i + 1] === "|" || src[i + 1] === "&" ? 2 : 1;
			continue;
		}
		if (c === "<" || c === ">" || c === "&") {
			// Redirection operator.
			let op = c;
			i++;
			if (c === "&") {
				op = "&>";
				i++;
			}
			while (i < n && (src[i] === ">" || src[i] === "<" || src[i] === "|" || src[i] === "&" || src[i] === "-")) {
				if (src[i] === "-" && op !== "<<") break;
				op += src[i];
				i++;
			}
			while (i < n && (src[i] === " " || src[i] === "\t")) i++;
			if (op === "<<" || op === "<<-") {
				const delimiter = readWord();
				pendingHeredocs.push({ delimiter, strip: op === "<<-", target: current });
				continue;
			}
			const target = readWord();
			if (op.endsWith("&") || op.includes(">&") || op.includes("<&")) {
				if (/^(\d+|-)$/.test(target)) continue;
			}
			if (op.startsWith(">") || op.startsWith("&>") || op.startsWith("<>")) current.redirects.push(target);
			continue;
		}
		const word = readWord();
		if (word === "" && i < n && !OPERATOR_CHARS.has(src[i])) i++;
		if (/^\d+$/.test(word) && (src[i] === ">" || src[i] === "<")) continue; // fd prefix of a redirection
		current.argv.push(word);
	}
	// Bodies of a heredoc whose line never ended are empty by definition.
	endCommand();
	return out;
}

// ---------------------------------------------------------------------------------------------
// Command rules
// ---------------------------------------------------------------------------------------------

interface Scope {
	root: string;
	releaseScope: boolean;
	role: "parent" | "child";
	remote: string;
	defaultBranch: string;
	/** Paths cannot be judged (an approver card has no worktree). */
	paths: boolean;
}

const RESERVED = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"!",
	"{",
	"}",
	"time",
	"case",
	"esac",
	"for",
	"in",
	"select",
	"coproc",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set([
	"python",
	"python3",
	"node",
	"bun",
	"deno",
	"perl",
	"ruby",
	"php",
	"osascript",
	"pwsh",
	"powershell",
	"lua",
	"tsx",
	"ts-node",
]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_ENV_DENY =
	/^(GIT_DIR|GIT_WORK_TREE|GIT_CONFIG[A-Z0-9_]*|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_ASKPASS|GIT_PROXY_COMMAND|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE)=/;

const GIT_VALUE_GLOBALS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--config-env",
	"--exec-path",
]);
const GIT_CONFIG_DENY =
	/^(alias\.|core\.(sshcommand|hookspath|editor|pager|fsmonitor|askpass|gitproxy)|url\.|remote\.|credential\.|include|filter\.|diff\.external|http\.|protocol\.|push\.|receive\.|uploadpack\.)/i;

interface ParsedGit {
	cwd?: string;
	configs: string[];
	gitDirFlag: boolean;
	sub: string;
	args: string[];
}

function parseGit(argv: string[], cwd: string): ParsedGit {
	const parsed: ParsedGit = { configs: [], gitDirFlag: false, sub: "", args: [] };
	let index = 1;
	let at = cwd;
	for (; index < argv.length; index++) {
		const word = argv[index];
		if (!word.startsWith("-")) break;
		const [flag, inline] = word.startsWith("--")
			? (word.split(/=(.*)/s, 2) as [string, string | undefined])
			: [word, undefined];
		if (flag === "-C") {
			const value = argv[++index] ?? "";
			const here = /^\$(PWD|\{PWD\})$/.test(value);
			at = here ? at : normalizePath(value, at);
			parsed.cwd = !here && /[$`~]/.test(value) ? "\u0000unresolvable" : at;
		} else if (flag === "-c") parsed.configs.push(argv[++index] ?? "");
		else if (flag === "--config-env") parsed.configs.push(inline ?? argv[++index] ?? "");
		else if (flag === "--git-dir" || flag === "--work-tree") {
			parsed.gitDirFlag = true;
			if (inline === undefined) index++;
		} else if (GIT_VALUE_GLOBALS.has(flag) && inline === undefined) index++;
	}
	parsed.sub = argv[index] ?? "";
	parsed.args = argv.slice(index + 1);
	return parsed;
}

function shortFlagLetters(arg: string): string {
	return /^-[a-zA-Z]+$/.test(arg) ? arg.slice(1) : "";
}

function gitPush(args: string[], scope: Scope): string | undefined {
	const positional: string[] = [];
	let tagsFlag = false;
	for (let k = 0; k < args.length; k++) {
		const arg = args[k];
		if (arg === "--") {
			positional.push(...args.slice(k + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const name = arg.split("=", 1)[0];
			if (name === "--force" || name.startsWith("--force-with-lease") || name === "--force-if-includes")
				return "force push is never allowed";
			if (name === "--mirror" || name === "--prune") return `git push ${name} is never allowed`;
			if (name === "--delete") return "deleting remote refs is never allowed";
			if (name === "--receive-pack" || name === "--exec") return `git push ${name} runs a program`;
			if (name === "--all") return "git push --all is never allowed";
			if (name === "--tags" || name === "--follow-tags") tagsFlag = true;
			if (name === "--repo" || name === "--push-option" || name === "-o") k += arg.includes("=") ? 0 : 1;
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			const letters = shortFlagLetters(arg);
			if (letters.includes("f")) return "force push is never allowed";
			if (letters.includes("d")) return "deleting remote refs is never allowed";
			if (letters === "o") k++;
			continue;
		}
		positional.push(arg);
	}
	const refspecs = positional.slice(1);
	for (const spec of refspecs) {
		if (spec.startsWith("+")) return "a +refspec is a force push and is never allowed";
		if (spec.startsWith(":")) return "pushing an empty source deletes a remote ref and is never allowed";
	}
	if (!scope.releaseScope) {
		return scope.role === "child"
			? "a child session never pushes"
			: "pushing is done by the runtime after a green cycle (ship level), never by you";
	}
	const remote = positional[0];
	if (!remote || remote !== scope.remote)
		return `only the configured remote "${scope.remote}" may be pushed to (by name, not by URL)`;
	if (tagsFlag && refspecs.length === 0) return undefined;
	if (refspecs.length === 0)
		return "a release push needs an explicit refspec (HEAD:<default branch> or a version tag)";
	let sawTagKeyword = false;
	for (const spec of refspecs) {
		if (sawTagKeyword) {
			sawTagKeyword = false;
			continue;
		}
		if (spec === "tag") {
			sawTagKeyword = true;
			continue;
		}
		if (spec === `HEAD:${scope.defaultBranch}` || spec === `HEAD:refs/heads/${scope.defaultBranch}`) continue;
		if (
			/^(refs\/tags\/)?v\d[\w.\-+]*$/.test(spec) ||
			/^refs\/tags\/v\d[\w.\-+]*:refs\/tags\/v\d[\w.\-+]*$/.test(spec)
		)
			continue;
		return `a release may only push HEAD:${scope.defaultBranch} (fast-forward) or a version tag, not "${spec}"`;
	}
	return undefined;
}

function gitTag(args: string[], scope: Scope): string | undefined {
	let creating = false;
	let listing = false;
	for (const arg of args) {
		if (arg === "-d" || arg === "--delete" || arg === "-f" || arg === "--force")
			return "deleting or moving a tag is never allowed";
		if (
			arg === "-l" ||
			arg === "--list" ||
			arg === "-n" ||
			arg.startsWith("--contains") ||
			arg.startsWith("--points-at") ||
			arg.startsWith("--merged") ||
			arg.startsWith("--no-merged") ||
			arg === "-v" ||
			arg === "--verify"
		)
			listing = true;
		else if (!arg.startsWith("-")) creating = true;
		else if (arg === "-a" || arg === "-s" || arg === "-m" || arg === "-F" || arg === "--annotate" || arg === "--sign")
			creating = true;
	}
	if (creating && !listing && !scope.releaseScope)
		return "creating a tag is only allowed while a release is due or requested";
	return undefined;
}

function gitCommand(argv: string[], scope: Scope, cwd: string): string | undefined {
	const git = parseGit(argv, cwd);
	if (git.gitDirFlag) return "git --git-dir/--work-tree reaches outside the worktree";
	if (git.cwd !== undefined && (git.cwd === "\u0000unresolvable" || (scope.paths && !isInside(git.cwd, scope.root))))
		return "git -C points outside your worktree";
	for (const config of git.configs)
		if (GIT_CONFIG_DENY.test(config))
			return `git -c ${config.split("=", 1)[0]} would change aliases, hooks, remotes or credentials`;
	const { sub, args } = git;
	const has = (...flags: string[]) => args.some(arg => flags.includes(arg));
	switch (sub) {
		case "push":
			return gitPush(args, scope);
		case "reset":
			return "git reset is never allowed (undo with git revert)";
		case "clean":
			return "git clean is never allowed";
		case "checkout": {
			const safe =
				(args[0] === "-b" || args[0] === "-c") &&
				!args.includes("--") &&
				!args.includes("-f") &&
				!args.includes("--force");
			return safe ? undefined : "git checkout can overwrite changes (use git switch, or git revert)";
		}
		case "switch":
			return has("-f", "--force", "--discard-changes", "-C", "--force-create")
				? "git switch would discard changes"
				: undefined;
		case "restore":
			return has("--staged", "-S") && !has("--worktree", "-W") ? undefined : "git restore would overwrite changes";
		case "stash":
			return args[0] === "drop" || args[0] === "clear" ? "dropping stashes is never allowed" : undefined;
		case "branch":
			return args.some(
				arg =>
					/^(-[dDmMfC]+|--delete|--move|--force|--copy)$/.test(arg) || /^-[a-zA-Z]*[dDmMf][a-zA-Z]*$/.test(arg),
			)
				? "deleting, renaming or force-moving a branch is never allowed"
				: undefined;
		case "tag":
			return gitTag(args, scope);
		case "rebase":
			return "git rebase rewrites history and is never allowed";
		case "commit":
			return has("--amend") || args.some(arg => arg.startsWith("--amend"))
				? "git commit --amend rewrites history and is never allowed"
				: undefined;
		case "pull":
			return has("--rebase", "-r") || args.some(arg => arg.startsWith("--rebase"))
				? "git pull --rebase rewrites history and is never allowed"
				: undefined;
		case "filter-branch":
		case "filter-repo":
			return "rewriting history is never allowed";
		case "reflog":
			return args[0] === "expire" || args[0] === "delete" ? "pruning the reflog is never allowed" : undefined;
		case "gc":
			return args.some(arg => arg.startsWith("--prune")) ? "git gc --prune is never allowed" : undefined;
		case "prune":
			return "git prune is never allowed";
		case "update-ref":
			return "git update-ref moves refs directly and is never allowed";
		case "worktree":
			return args[0] === "remove" && has("--force", "-f")
				? "git worktree remove --force is never allowed"
				: undefined;
		case "remote": {
			const verb = args.find(arg => !arg.startsWith("-"));
			if (verb === undefined || verb === "show" || verb === "get-url") return undefined;
			return "changing remotes is never allowed";
		}
		case "config": {
			if (
				has(
					"--get",
					"--get-all",
					"--get-regexp",
					"--get-urlmatch",
					"-l",
					"--list",
					"--show-origin",
					"--show-scope",
					"--name-only",
				)
			)
				return undefined;
			if (
				args.some(arg => /^--(add|replace-all|unset|unset-all|rename-section|remove-section|edit)$|^-e$/.test(arg))
			)
				return "git config writes are never allowed";
			const positional = args.filter(arg => !arg.startsWith("-"));
			return positional.length >= 2 ? "git config writes are never allowed" : undefined;
		}
		default:
			return undefined;
	}
}

const GH_READ = new Set([
	"pr view",
	"pr list",
	"pr diff",
	"pr checks",
	"pr status",
	"issue view",
	"issue list",
	"issue status",
	"run list",
	"run view",
	"repo view",
	"release view",
	"release list",
	"workflow list",
	"workflow view",
	"auth status",
	"search",
	"status",
]);

function ghCommand(argv: string[], scope: Scope): string | undefined {
	const words: string[] = [];
	for (let k = 1; k < argv.length; k++) {
		const arg = argv[k];
		if (arg === "-R" || arg === "--repo") {
			k++;
			continue;
		}
		if (arg.startsWith("-")) {
			if (words.length >= 2 || (words[0] === "api" && words.length >= 1)) break;
			continue;
		}
		words.push(arg);
		if (words.length === 2) break;
	}
	const rest = argv.slice(1);
	const group = words[0] ?? "";
	const key = `${group} ${words[1] ?? ""}`.trim();
	if (group === "repo" && words[1] === "delete") return "gh repo delete is never allowed";
	if (group === "api") {
		const writes = rest.some((arg, k) => {
			if (/^(-X|--method)$/.test(arg)) return !/^get$/i.test(rest[k + 1] ?? "");
			if (/^(--method=)/.test(arg)) return !/^--method=get$/i.test(arg);
			if (/^-X./.test(arg)) return !/^-XGET$/i.test(arg);
			return /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(arg);
		});
		return writes ? "gh api writes are not allowed" : undefined;
	}
	if (group === "search") return undefined;
	if (GH_READ.has(key)) return undefined;
	if (scope.releaseScope) {
		if (key === "workflow run") return undefined;
		if (key === "run watch") return undefined;
		if (key === "run rerun" && rest.includes("--failed")) return undefined;
	}
	if (group === "workflow" || group === "run") return `gh ${key} is only allowed while a release is due or requested`;
	return `gh ${key || group} changes GitHub state and is not allowed`;
}

const PUBLISHERS: Array<[string, string]> = [
	["cargo", "publish"],
	["twine", "upload"],
	["docker", "push"],
	["docker", "login"],
	["gem", "push"],
	["poetry", "publish"],
	["uv", "publish"],
	["vsce", "publish"],
	["ovsx", "publish"],
	["mvn", "deploy"],
	["gradle", "publish"],
];
const NODE_PM = new Set(["npm", "pnpm", "yarn", "bun", "npx", "bunx", "corepack"]);
const GLOBAL_VERBS = new Set(["install", "i", "add", "link", "uninstall", "remove", "rm", "update", "upgrade", "up"]);

function packageCommand(name: string, argv: string[]): string | undefined {
	const rest = argv.slice(1);
	const words = rest.filter(arg => !arg.startsWith("-"));
	for (const [bin, verb] of PUBLISHERS)
		if (name === bin && words[0] === verb) return `${bin} ${verb} publishes artifacts and is not allowed`;
	if (
		rest.some(
			(arg, k) => (arg === "--publish" || arg === "-p") && /^(always|onTag|onTagOrDraft)$/.test(rest[k + 1] ?? ""),
		) ||
		rest.some(arg => /^--publish=(always|onTag|onTagOrDraft)$/.test(arg))
	)
		return "--publish always publishes artifacts and is not allowed";
	if (NODE_PM.has(name)) {
		if (
			words[0] === "publish" ||
			(words[0] === "npm" && words[1] === "publish") ||
			(words[0] === "dist-tag" && words[1] !== "ls")
		)
			return `${name} publish is not allowed`;
		if (
			(rest.includes("-g") || rest.includes("--global") || words[0] === "global") &&
			(words[0] === "global" || GLOBAL_VERBS.has(words[0] ?? ""))
		)
			return "global installs are not allowed";
	}
	if (name === "cargo" && words[0] === "install") return "cargo install is a global install and is not allowed";
	if (name === "brew" && /^(install|upgrade|uninstall|reinstall|tap|untap|link|unlink)$/.test(words[0] ?? ""))
		return "brew changes the system and is not allowed";
	if (/^(apt|apt-get|dnf|yum|pacman|apk|zypper|snap|choco|winget|scoop)$/.test(name))
		return "system package managers are not allowed";
	if (name === "pipx") return "pipx is a global install and is not allowed";
	return undefined;
}

function omp(name: string, argv: string[]): string | undefined {
	if (name !== "omp" && name !== "ompdesk") return undefined;
	const sub = argv.slice(1).find(arg => !arg.startsWith("-"));
	if (
		sub &&
		/^(config|login|logout|auth|accounts|account|setup|update|plugin|plugins|install|uninstall|mcp|providers|provider)$/.test(
			sub,
		)
	)
		return `omp ${sub} changes account, provider or app settings`;
	return undefined;
}

const PATH_ONLY_WRITERS = new Set([
	"tee",
	"touch",
	"mkdir",
	"chmod",
	"chown",
	"chgrp",
	"truncate",
	"mkfifo",
	"mknod",
	"sponge",
	"patch",
]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "trash", "mv", "srm"]);
const COPIERS = new Set(["cp", "rsync", "install", "ln", "scp"]);

function nonFlagArgs(args: string[]): string[] {
	const out: string[] = [];
	let afterDashes = false;
	for (const arg of args) {
		if (!afterDashes && arg === "--") afterDashes = true;
		else if (afterDashes || !arg.startsWith("-")) out.push(arg);
	}
	return out;
}

function writerCommand(name: string, argv: string[], scope: Scope, cwd: string): string | undefined {
	if (!scope.paths) {
		// No worktree known (an approval card): still refuse deletes aimed at home or system roots.
		const home =
			/^(~|\$HOME|\$\{HOME\}|\/\*?$|\/(etc|usr|bin|sbin|var|opt|Users|home|System|Library|root|Applications)(\/|$))/;
		return DELETERS.has(name) && nonFlagArgs(argv.slice(1)).some(arg => home.test(arg))
			? "deleting outside the worktree is never allowed"
			: undefined;
	}
	const args = argv.slice(1);
	let targets: string[] = [];
	let scratch = false;
	if (DELETERS.has(name)) targets = nonFlagArgs(args);
	else if (COPIERS.has(name)) {
		const rest = nonFlagArgs(args);
		const tIndex = args.findIndex(arg => arg === "-t" || arg === "--target-directory");
		targets = tIndex >= 0 && args[tIndex + 1] ? [args[tIndex + 1]] : rest.slice(-1);
		scratch = name !== "ln";
	} else if (PATH_ONLY_WRITERS.has(name)) {
		targets = nonFlagArgs(args);
		scratch = name === "tee" || name === "touch" || name === "mkdir";
	} else if (name === "dd") targets = args.filter(arg => arg.startsWith("of=")).map(arg => arg.slice(3));
	else if (name === "sed" || name === "perl") {
		if (!args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) return undefined;
		targets = nonFlagArgs(args).slice(1);
	} else if (name === "curl") {
		for (let k = 0; k < args.length; k++)
			if (args[k] === "-o" || args[k] === "--output") targets.push(args[k + 1] ?? "");
		scratch = true;
	} else if (name === "wget") {
		for (let k = 0; k < args.length; k++) if (args[k] === "-O" || args[k] === "-P") targets.push(args[k + 1] ?? "");
		scratch = true;
	} else if (name === "find") {
		if (
			!args.some(
				arg =>
					arg === "-delete" || arg === "-exec" || arg === "-execdir" || arg === "-fprint" || arg === "-fdelete",
			)
		)
			return undefined;
		for (const arg of args) {
			if (arg.startsWith("-") || arg === "(" || arg === "!") break;
			targets.push(arg);
		}
		if (targets.length === 0) targets = ["."];
	} else return undefined;
	for (const target of targets) {
		const problem = writePathProblem(target, cwd, scope.root, scratch);
		if (problem) return problem;
	}
	return undefined;
}

/** Strips env assignments and wrapper commands; returns the real command's argv or an immediate verdict. */
function unwrap(argv: string[]): { argv: string[]; reason?: string } {
	const words = [...argv];
	for (let guard = 0; guard < 16; guard++) {
		while (words.length > 0 && RESERVED.has(words[0])) words.shift();
		while (words.length > 0 && ENV_ASSIGN.test(words[0])) {
			if (GIT_ENV_DENY.test(words[0]))
				return { argv: words, reason: `${words[0].split("=", 1)[0]} would redirect or reconfigure git` };
			words.shift();
		}
		const head = words[0]?.split("/").pop() ?? "";
		if (head === "sudo" || head === "doas" || head === "su")
			return { argv: words, reason: "privilege escalation is not allowed" };
		if (head === "env") {
			words.shift();
			while (words.length > 0 && (words[0].startsWith("-") || ENV_ASSIGN.test(words[0]))) {
				if (GIT_ENV_DENY.test(words[0]))
					return { argv: words, reason: `${words[0].split("=", 1)[0]} would redirect or reconfigure git` };
				const flag = words.shift() as string;
				if (flag === "-u" || flag === "-C" || flag === "-S") words.shift();
			}
			continue;
		}
		if (
			[
				"command",
				"builtin",
				"exec",
				"nohup",
				"setsid",
				"caffeinate",
				"stdbuf",
				"ionice",
				"chronic",
				"unbuffer",
			].includes(head)
		) {
			words.shift();
			while (words.length > 0 && words[0].startsWith("-")) words.shift();
			continue;
		}
		if (head === "nice") {
			words.shift();
			while (words.length > 0 && words[0].startsWith("-")) {
				const flag = words.shift() as string;
				if (flag === "-n") words.shift();
			}
			continue;
		}
		if (head === "timeout") {
			words.shift();
			while (words.length > 0 && words[0].startsWith("-")) {
				const flag = words.shift() as string;
				if (flag === "-s" || flag === "-k") words.shift();
			}
			words.shift();
			continue;
		}
		if (head === "xargs") {
			words.shift();
			while (words.length > 0 && words[0].startsWith("-")) {
				const flag = words.shift() as string;
				if (/^-[IniPLdEsa]$/.test(flag)) words.shift();
			}
			continue;
		}
		if (head === "watch") {
			words.shift();
			while (words.length > 0 && words[0].startsWith("-")) {
				const flag = words.shift() as string;
				if (flag === "-n" || flag === "-d") words.shift();
			}
			continue;
		}
		break;
	}
	return { argv: words };
}

function analyzeSimple(cmd: Simple, scope: Scope, state: { cwd: string }, depth: number): string | undefined {
	if (cmd.argv[0] === TOO_DEEP) return "the command is nested too deeply to verify";
	if (scope.paths) {
		for (const target of cmd.redirects) {
			const problem = writePathProblem(target, state.cwd, scope.root, true);
			if (problem) return `redirecting output: ${problem}`;
		}
	}
	const unwrapped = unwrap(cmd.argv);
	if (unwrapped.reason) return unwrapped.reason;
	const argv = unwrapped.argv;
	if (argv.length === 0) return undefined;
	const name = argv[0].split("/").pop() ?? argv[0];
	const heredoc = cmd.heredocs.join("\n");

	if (name === "cd" || name === "pushd") {
		const target = argv[1] ?? "~";
		const resolved = resolveWord(target, state.cwd);
		state.cwd = resolved.path ?? "\u0000unresolvable";
		return undefined;
	}
	if (SHELLS.has(name)) {
		const flagIndex = argv.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
		if (flagIndex >= 0 && argv[flagIndex + 1] !== undefined)
			return analyzeScript(argv[flagIndex + 1], scope, state, depth + 1);
		if (heredoc) return analyzeScript(heredoc, scope, state, depth + 1);
		const script = argv.slice(1).find(arg => !arg.startsWith("-"));
		return script ? `running the script "${script}" cannot be verified` : undefined;
	}
	if (name === "eval") return analyzeScript(argv.slice(1).join(" "), scope, state, depth + 1);
	if (name === "source" || name === ".") return "sourcing a file cannot be verified";
	if (INTERPRETERS.has(name) || /^python[\d.]+$/.test(name)) {
		// Inline code: the banned phrases are all we can see of it (known limit).
		const code = [heredoc, ...argv.slice(1).filter(arg => /\s/.test(arg))].filter(Boolean).join("\n");
		const hit = code ? scanBannedPhrases(code, scope) : undefined;
		if (hit) return hit;
	}
	if (name === "ssh" || name === "scp" || name === "sftp") return `${name} reaches outside the worktree`;
	if (name === "git") return gitCommand(argv, scope, state.cwd);
	if (name === "gh") return ghCommand(argv, scope);
	const pkg = packageCommand(name, argv);
	if (pkg) return pkg;
	const settings = omp(name, argv);
	if (settings) return settings;
	if (name === "find") {
		const exec = argv.findIndex(arg => arg === "-exec" || arg === "-execdir" || arg === "-ok");
		if (exec >= 0) {
			const end = argv.findIndex((arg, k) => k > exec && (arg === ";" || arg === "+" || arg === "\\;"));
			const inner = argv.slice(exec + 1, end === -1 ? undefined : end);
			const reason = analyzeSimple(
				{ argv: inner, redirects: [], heredocs: [] },
				scope,
				{ cwd: state.cwd },
				depth + 1,
			);
			if (reason) return reason;
		}
	}
	return writerCommand(name, argv, scope, state.cwd);
}

function analyzeScript(src: string, scope: Scope, state: { cwd: string }, depth: number): string | undefined {
	for (const cmd of parseShell(src, depth)) {
		const reason = analyzeSimple(cmd, scope, state, depth);
		if (reason) return reason;
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Text-level scan: inline interpreter code and approval card text
// ---------------------------------------------------------------------------------------------

const BAN_PHRASES: Array<[RegExp, string]> = [
	[
		/\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*(\s--force\b|\s-f\b|--force-with-lease|\s--mirror\b|\s--delete\b|\s\+\S)/,
		"force or delete pushes are never allowed",
	],
	[/\bgit\b[^\n;|&]*\breset\b/, "git reset is never allowed"],
	[/\bgit\b[^\n;|&]*\bclean\b[^\n;|&]*\s-[a-zA-Z]*[fdx]/, "git clean is never allowed"],
	[/\bgit\b[^\n;|&]*\brebase\b/, "git rebase rewrites history and is never allowed"],
	[/\bgit\b[^\n;|&]*\bcommit\b[^\n;|&]*--amend\b/, "git commit --amend rewrites history and is never allowed"],
	[/\bgit\b[^\n;|&]*\b(filter-branch|filter-repo)\b/, "rewriting history is never allowed"],
	[/\bgit\b[^\n;|&]*\bupdate-ref\b/, "git update-ref moves refs directly and is never allowed"],
	[/\bgit\b[^\n;|&]*\bstash\s+(drop|clear)\b/, "dropping stashes is never allowed"],
	[/\bgit\b[^\n;|&]*\bbranch\s+(-[dDmM]|--delete|--move)\b/, "deleting or renaming a branch is never allowed"],
	[/\bgit\b[^\n;|&]*\btag\s+(-d|--delete)\b/, "deleting a tag is never allowed"],
	[/\bgit\b[^\n;|&]*\bremote\s+(add|set-url|remove|rm|rename)\b/, "changing remotes is never allowed"],
	[/\bgit\b[^\n;|&]*\breflog\s+(expire|delete)\b/, "pruning the reflog is never allowed"],
	[/\bgit\b[^\n;|&]*\bgc\b[^\n;|&]*--prune/, "git gc --prune is never allowed"],
	[/\bgh\s+repo\s+delete\b/, "gh repo delete is never allowed"],
	[
		/\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+(\/|~|\$HOME|\$\{HOME\})(\s|$|\/\s|\/\*)/,
		"recursive deletes outside the worktree are never allowed",
	],
	[
		/\b(shutil\.rmtree|fs\.rmSync|fs\.rm\b|rimraf|os\.removedirs)\b[^\n]*['"`](\/|~)/,
		"deleting outside the worktree is never allowed",
	],
];

const PUSH_PHRASE = /\bgit\b[^\n;|&]*\bpush\b/;

function scanBannedPhrases(text: string, scope: Scope): string | undefined {
	for (const [pattern, reason] of BAN_PHRASES) if (pattern.test(text)) return reason;
	if (!scope.releaseScope && PUSH_PHRASE.test(text))
		return scope.role === "child"
			? "a child session never pushes"
			: "pushing is done by the runtime after a green cycle, never by you";
	return undefined;
}

function scopeFrom(options: BanScanOptions): Scope {
	const role = options.role ?? "parent";
	return {
		root: options.root ? normalizePath(options.root, "/") : "/",
		releaseScope: role === "parent" && (options.shipLevel === "release" || options.oneShotRelease === true),
		role,
		remote: options.remote ?? "origin",
		defaultBranch: options.defaultBranch ?? "main",
		paths: options.root !== undefined,
	};
}

/** Why a shell command line is not allowed, or undefined. */
export function bashViolation(command: string, options: BanScanOptions & { cwd?: string }): string | undefined {
	const scope = scopeFrom(options);
	const cwd = options.cwd ? normalizePath(options.cwd, scope.root) : scope.root;
	return analyzeScript(command, scope, { cwd }, 0);
}

/**
 * The first hard-limit violation in free text (an approval card's title and body, a command preview),
 * or undefined. Reads every line and every quoted string as a shell command line, and scans the whole
 * text for banned phrases. Without `options.root` path rules are skipped.
 */
export function findBanViolation(text: string, options: BanScanOptions = {}): string | undefined {
	const scope = scopeFrom(options);
	const candidates = new Set<string>([text]);
	for (const line of text.split("\n")) candidates.add(line.replace(/^\s*(\$|>|bash|command|cmd)[:\s]*/i, ""));
	for (const match of text.matchAll(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
		try {
			candidates.add(JSON.parse(`"${match[1]}"`) as string);
		} catch {
			candidates.add(match[1]);
		}
	}
	for (const candidate of candidates) {
		const phrase = scanBannedPhrases(candidate, scope);
		if (phrase) return phrase;
		const reason = bashViolation(candidate, options);
		if (reason) return reason;
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Tool-level rules
// ---------------------------------------------------------------------------------------------

const FILE_TOOLS = new Set(["write", "edit", "ast_edit", "notebook", "lsp"]);
const PATH_KEYS = [
	"path",
	"file",
	"file_path",
	"filePath",
	"notebook_path",
	"notebookPath",
	"target",
	"dest",
	"destination",
	"glob",
];
const PATH_LIST_KEYS = ["paths", "files"];
const ALLOWED_SCHEMES = new Set(["xd", "local", "artifact", "agent", "proc", "history", "skill"]);

function collectPaths(input: unknown): string[] {
	const found: string[] = [];
	if (typeof input !== "object" || input === null) return found;
	const record = input as Record<string, unknown>;
	for (const key of PATH_KEYS) if (typeof record[key] === "string") found.push(record[key] as string);
	for (const key of PATH_LIST_KEYS)
		if (Array.isArray(record[key]))
			for (const item of record[key] as unknown[]) if (typeof item === "string") found.push(item);
	for (const value of Object.values(record)) {
		if (typeof value !== "string" || value.length < 4) continue;
		for (const match of value.matchAll(/^\[([^\]#\n]+)#[0-9A-Fa-f]{2,8}\]/gm)) found.push(match[1]);
		for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) found.push(match[1].trim());
		for (const match of value.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) found.push(match[1]);
		for (const match of value.matchAll(/^MV\s+(\S+)\s*$/gm)) found.push(match[1].replace(/^["']|["']$/g, ""));
	}
	return found;
}

function globBase(pattern: string): string {
	const cut = pattern.search(/[*?[{]/);
	return cut === -1 ? pattern : pattern.slice(0, cut).replace(/[^/\\]*$/, "") || ".";
}

function pathToolViolation(toolName: string, input: unknown, scope: Scope): string | undefined {
	for (const raw of collectPaths(input)) {
		const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
		if (scheme) {
			if (ALLOWED_SCHEMES.has(scheme[1].toLowerCase())) continue;
			return `${toolName} to ${scheme[1]}:// is not allowed`;
		}
		const problem = writePathProblem(globBase(raw), scope.root, scope.root, false);
		if (problem) return `${toolName}: ${problem}`;
	}
	return undefined;
}

const GITHUB_READ_OPS = new Set([
	"repo_view",
	"file_read",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
]);

function githubViolation(input: unknown): string | undefined {
	const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	const op = typeof record.op === "string" ? record.op : "";
	if (record.force || record.forceWithLease) return "force options of the github tool are never allowed";
	if (op === "pr_push" || op === "pr_create" || op === "pr_checkout")
		return `github ${op} pushes, publishes or switches branches and is not allowed`;
	if (!GITHUB_READ_OPS.has(op)) return `github ${op || "(no op)"} is not allowed`;
	return undefined;
}

/** Whether the guard blocks this tool call. Pure; every caller passes what it knows. */
export function evaluateToolCall(call: GuardInput): GuardDecision {
	const scope = scopeFrom({
		root: call.root,
		shipLevel: call.shipLevel,
		oneShotRelease: call.oneShotRelease,
		role: call.role,
		remote: call.remote,
		defaultBranch: call.defaultBranch,
	});
	const input = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {};
	switch (call.toolName) {
		case "bash": {
			const command = typeof input.command === "string" ? input.command : "";
			const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
			const reason = bashViolation(command, {
				root: call.root,
				shipLevel: call.shipLevel,
				oneShotRelease: call.oneShotRelease,
				role: call.role,
				remote: call.remote,
				defaultBranch: call.defaultBranch,
				cwd,
			});
			return reason ? deny(reason) : ALLOW;
		}
		case "eval":
		case "debug":
			return deny(`${call.toolName} can run code that bypasses the guard`);
		case "ssh":
			return deny("ssh reaches outside the worktree");
		case "ask":
			return deny("you never ask the user: decide yourself and state the assumption");
		case "github": {
			const reason = githubViolation(input);
			return reason ? deny(reason) : ALLOW;
		}
		case "autopilot":
			return call.role === "child" ? deny("a child session has no autopilot tool") : ALLOW;
		default:
			if (FILE_TOOLS.has(call.toolName)) {
				const reason = pathToolViolation(call.toolName, input, scope);
				return reason ? deny(reason) : ALLOW;
			}
			return ALLOW;
	}
}
