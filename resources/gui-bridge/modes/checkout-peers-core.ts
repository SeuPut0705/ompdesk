/**
 * Rules for sessions that share a checkout (contracts: checkout-peers-contracts.ts): the prompt section that names the
 * other sessions and how to reach them, the `tool_call` guard that refuses a step which would take, overwrite or hide
 * another session's work, and the notices that tell a session of an overlap. Pure; the bridge module
 * (checkout-peers.ts) and the GUI's tests call it.
 *
 * The guard reads `bash` with Autopilot's own shell parser (`shellEffects`) and judges each git run by one table
 * (`GIT_RULES`): a repository-wide step (stash, deleting or moving a branch another session may own) is refused while
 * any other session works in any worktree of the repository; a worktree step (switching or resetting the checkout,
 * cleaning, bulk staging, `commit -a`, a commit without paths, merge, pull, rebase, cherry-pick, revert, am, apply)
 * while another session works in the same worktree; a step on named paths only when a path is broad (`.`, a directory,
 * a glob, a command substitution) or names a file another session changed. Two kinds of path steps: a "take" (`git
 * add`, `git commit -- paths`) is allowed for a file this session changed too (the overlap notice already asks for a
 * note first), a "drop" (`checkout`/`restore`/`rm`/`reset` of paths, a whole-file write or a delete) is not. The same
 * judgment applies to a git run or a write aimed into another session's worktree of the repository. A session working
 * alone is never judged; a session in another worktree is never refused over its files in this worktree, only warned
 * of the merge.
 */
import {
	type FileToolEffect,
	fileToolEffects,
	foldsCase,
	type GitInvocation,
	hasGitSegment,
	inlineCodeEffects,
	isInside,
	isScratch,
	normalizePath,
	type ShellEffects,
	shellEffects,
} from "./autopilot-guard-core";
import { ClaimBook } from "./checkout-claims";
import {
	CHECKOUT_PEERS_SET,
	CHECKOUT_REFUSAL_PREFIX,
	CHECKOUT_TASK_MAX,
	type CheckoutPeer,
	type CheckoutPeers,
} from "./checkout-peers-contracts";

/** What one git run does to shared state, before knowing who else works here. */
type Hazard =
	| { scope: "repo"; what: string; instead: string }
	| { scope: "worktree"; what: string; instead: string }
	| { scope: "paths"; paths: string[]; takes: boolean; what: string; instead: string }
	| { scope: "worktrees"; paths: string[]; what: string; instead: string };

/** What a git rule may ask of the file system and of this session's own work. */
interface GitAt {
	/** Whether a word names an existing file or folder (from the run's folder). */
	exists(word: string): boolean;
	/** The branches this session created. */
	ownBranches: ReadonlySet<string>;
}

const FINISHING = ["--abort", "--continue", "--skip", "--quit"];
/** Finishing or leaving an operation already underway changes nothing new. */
const finishing = (args: string[]) => args.some(arg => FINISHING.includes(arg));
const WORKTREE_INSTEAD = "Do it in a worktree of your own, or ask the other session to commit first.";

const REV = /^((HEAD|@|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD)([~^]\d*)*|[0-9a-f]{7,40})$/;
/** Flags whose value is the next word, per subcommand (so a message or a source is never read as a path). */
const VALUE_FLAGS: Record<string, readonly string[]> = {
	commit: [
		"-m",
		"--message",
		"-F",
		"--file",
		"-C",
		"-c",
		"--reuse-message",
		"--reedit-message",
		"--author",
		"--date",
		"--fixup",
		"--squash",
		"-t",
		"--template",
		"--cleanup",
	],
	restore: ["-s", "--source"],
	checkout: ["-b", "-B", "--orphan", "--conflict"],
	add: ["--chmod", "--pathspec-from-file"],
	rm: ["--pathspec-from-file"],
	reset: ["--pathspec-from-file"],
	clean: ["-e", "--exclude"],
};
/** The short flags whose value is the rest of the cluster or the next word (`-m msg`, `-vm msg`, `-mmsg`). */
const VALUE_LETTERS: Record<string, string> = { commit: "mFCct", restore: "s", checkout: "bB", clean: "e" };

/**
 * `args` split into flags and the words that are not flags or flag values; everything after `--` is a word. A short
 * cluster is cut after its value letter (`-vmfix` is `-vm` with the value `fix`), and `-vm msg` takes the next word.
 */
function split(sub: string, args: string[]): { flags: string[]; words: string[]; afterDashes: string[] | null } {
	const flags: string[] = [];
	const words: string[] = [];
	const valued = VALUE_FLAGS[sub];
	const letters = VALUE_LETTERS[sub] ?? "";
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") return { flags, words, afterDashes: args.slice(index + 1) };
		if (arg.startsWith("-") && arg !== "-") {
			const at = /^-[a-zA-Z]+$/.test(arg) ? [...arg.slice(1)].findIndex(letter => letters.includes(letter)) : -1;
			if (at >= 0) {
				flags.push(arg.slice(0, at + 2));
				if (at + 2 === arg.length) index++;
			} else {
				flags.push(arg);
				if (valued?.includes(arg)) index++;
			}
		} else words.push(arg);
	}
	return { flags, words, afterDashes: null };
}

/** A short-flag cluster (`-am`) or a long flag naming one of `letters`/`long`. */
function hasFlag(flags: string[], letters: string, long: string[]): boolean {
	return flags.some(
		flag =>
			long.includes(flag.split("=", 1)[0]) ||
			(/^-[a-zA-Z]+$/.test(flag) && [...letters].some(letter => flag.includes(letter))),
	);
}

const STAGE_INSTEAD = "Stage only files you changed, by name: git add -- <file>…";
const RESTORE_INSTEAD = "To undo your own change to one file: git restore -- <that file>.";

/** Each git subcommand that can take, overwrite or hide another session's work, and how. */
const GIT_RULES: Record<string, (args: string[], at: GitAt) => Hazard | undefined> = {
	stash: args =>
		args[0] === "list" || args[0] === "show" || args.includes("--help") || args.includes("-h")
			? undefined
			: {
					scope: "repo",
					what: "git stash is one stack for every worktree of this repository: another session's stash and yours mix, and a pop can apply theirs",
					instead: "Commit your work in progress to your branch instead: git commit -- <your files>.",
				},
	branch: (args, at) => {
		const changing = args.some(
			arg => /^--(delete|move|force|copy)$/.test(arg) || /^-[a-zA-Z]*[dDmMfcC][a-zA-Z]*$/.test(arg),
		);
		if (!changing) return undefined;
		// A branch this session made is its own to delete or move.
		const named = split("branch", args).words;
		if (named.length > 0 && named.every(name => at.ownBranches.has(name))) return undefined;
		return {
			scope: "repo",
			what: "deleting, moving or force-setting a branch changes refs every worktree of this repository shares",
			instead: "Leave branches you did not create alone; ask whoever made one.",
		};
	},
	add: args => {
		const { flags, words, afterDashes } = split("add", args);
		const named = [...words, ...(afterDashes ?? [])];
		// Without a path, -A/-u and the interactive modes (-p, -i, -e) take the whole tree (":/" is git's own "from the top").
		if (hasFlag(flags, "Auipe", ["--all", "--update", "--pathspec-from-file", "--patch", "--interactive", "--edit"]))
			return {
				scope: "paths",
				takes: true,
				paths: named.length > 0 ? named : [":/"],
				what: "bulk staging would take the other session's changes too",
				instead: STAGE_INSTEAD,
			};
		return {
			scope: "paths",
			takes: true,
			paths: named,
			what: "staging these paths would take the other session's changes",
			instead: STAGE_INSTEAD,
		};
	},
	commit: args => {
		const { flags, words, afterDashes } = split("commit", args);
		const instead = "Commit only files you changed, by name: git commit -m <message> -- <file>…";
		if (hasFlag(flags, "a", ["--all"]))
			return {
				scope: "worktree",
				what: "git commit -a commits every changed file in this checkout, the other session's too",
				instead,
			};
		if (hasFlag(flags, "", ["--amend"]))
			return {
				scope: "worktree",
				what: "git commit --amend rewrites the last commit, which may be the other session's, and takes what is staged",
				instead,
			};
		if (hasFlag(flags, "i", ["--include"]))
			return {
				scope: "worktree",
				what: "git commit --include also commits everything staged in this checkout's shared index, files the other session staged too",
				instead,
			};
		const paths = [...words, ...(afterDashes ?? [])];
		// Without paths a commit takes whatever the shared index holds: measured, another session's `git add` landed in
		// this session's commit. With paths git commits only those (`--only`, its default).
		return paths.length > 0
			? {
					scope: "paths",
					takes: true,
					paths,
					what: "committing these paths would take the other session's changes",
					instead,
				}
			: {
					scope: "worktree",
					what: "a commit without paths takes everything staged in this checkout's shared index, files the other session staged too",
					instead,
				};
	},
	checkout: (args, at) => {
		const { flags, words, afterDashes } = split("checkout", args);
		const drops = (paths: string[], what: string): Hazard => ({
			scope: "paths",
			takes: false,
			paths,
			what,
			instead: RESTORE_INSTEAD,
		});
		if (afterDashes)
			return drops(afterDashes, "checking out these paths would overwrite the other session's changes");
		const broad = words.filter(word => word === "." || /[*?[]/.test(word));
		if (broad.length > 0)
			return drops(broad, "checking out the whole tree would overwrite the other session's changes");
		if (hasFlag(flags, "p", ["--patch"])) {
			const named = words.filter(word => at.exists(word));
			return drops(
				named.length > 0 ? named : [":/"],
				"checking out hunks of the tree would overwrite the other session's changes",
			);
		}
		// Words that are all existing files are paths, not a branch.
		if (words.length > 0 && words.every(word => at.exists(word)))
			return drops(words, "checking out these paths would overwrite the other session's changes");
		return {
			scope: "worktree",
			what: "git checkout here switches the branch (or overwrites files) under the other session too",
			instead: `${RESTORE_INSTEAD} To work on another branch, use a worktree of your own.`,
		};
	},
	switch: () => ({
		scope: "worktree",
		what: "git switch moves this checkout to another branch under the other session too",
		instead: "To work on another branch, use a worktree of your own.",
	}),
	restore: args => {
		const { words, afterDashes } = split("restore", args);
		return {
			scope: "paths",
			takes: false,
			paths: [...words, ...(afterDashes ?? [])],
			what: "restoring these paths would overwrite the other session's changes",
			instead: RESTORE_INSTEAD,
		};
	},
	reset: (args, at) => {
		const { flags, words, afterDashes } = split("reset", args);
		if (hasFlag(flags, "", ["--hard", "--merge", "--keep"]))
			return {
				scope: "worktree",
				what: "git reset --hard throws away every uncommitted change in this checkout, the other session's too",
				instead: RESTORE_INSTEAD,
			};
		// A word that is no revision and names an existing file is a path; any other word is a revision to move to.
		const paths = [...words.filter(word => !REV.test(word) && at.exists(word)), ...(afterDashes ?? [])];
		return paths.length > 0
			? {
					scope: "paths",
					takes: false,
					paths,
					what: "unstaging these paths would undo the other session's staging",
					instead: "Unstage only your own files: git restore --staged -- <file>.",
				}
			: {
					scope: "worktree",
					what: "git reset moves HEAD and the index of this checkout under the other session too",
					instead: "Unstage your own files with git restore --staged -- <file>; undo a commit with git revert.",
				};
	},
	clean: args => {
		const { flags, words, afterDashes } = split("clean", args);
		if (!hasFlag(flags, "f", ["--force"]) || hasFlag(flags, "n", ["--dry-run"])) return undefined;
		const paths = [...words, ...(afterDashes ?? [])];
		return paths.length > 0
			? {
					scope: "paths",
					takes: false,
					paths,
					what: "git clean deletes untracked files under these paths, the other session's new files too",
					instead: "Delete the untracked files you made, by name.",
				}
			: {
					scope: "worktree",
					what: "git clean deletes untracked files in this checkout, the other session's new files too",
					instead: "Delete the untracked files you made, by name.",
				};
	},
	rm: args => {
		const { words, afterDashes } = split("rm", args);
		return {
			scope: "paths",
			takes: false,
			paths: [...words, ...(afterDashes ?? [])],
			what: "removing these paths would delete the other session's work",
			instead: "Remove only files you made, by name.",
		};
	},
	mv: args => {
		const { words } = split("mv", args);
		return {
			scope: "paths",
			takes: false,
			paths: words,
			what: "moving these paths would move files the other session works on",
			instead: "Move only files you made.",
		};
	},
	merge: args =>
		finishing(args) || args.includes("--ff-only")
			? undefined
			: {
					scope: "worktree",
					what: "git merge rewrites this checkout's files, index and HEAD under the other session, and a conflict leaves markers in files it may be editing",
					instead: WORKTREE_INSTEAD,
				},
	pull: args =>
		args.includes("--ff-only")
			? undefined
			: {
					scope: "worktree",
					what: "git pull merges or rebases the remote's commits into this checkout, rewriting files under the other session too",
					instead:
						"git fetch is safe here; merge or rebase in a worktree of your own, or after the other session has committed.",
				},
	rebase: args =>
		finishing(args)
			? undefined
			: {
					scope: "worktree",
					what: "git rebase rewrites this branch and checks its commits out again under the other session, and stops on conflicts in files it may be editing",
					instead: WORKTREE_INSTEAD,
				},
	"cherry-pick": args =>
		finishing(args)
			? undefined
			: {
					scope: "worktree",
					what: "git cherry-pick applies a commit to this checkout's files and index under the other session, and stops on conflicts in files it may be editing",
					instead: WORKTREE_INSTEAD,
				},
	revert: args =>
		finishing(args)
			? undefined
			: {
					scope: "worktree",
					what: "git revert applies the inverse of a commit to this checkout's files and index under the other session, and stops on conflicts in files it may be editing",
					instead: WORKTREE_INSTEAD,
				},
	am: args =>
		finishing(args) || args.some(arg => arg.startsWith("--show-current-patch"))
			? undefined
			: {
					scope: "worktree",
					what: "git am applies patches to this checkout's files and index and commits them under the other session, and stops on conflicts in files it may be editing",
					instead: WORKTREE_INSTEAD,
				},
	apply: args => {
		const { flags } = split("apply", args);
		// A check or report flag turns applying off, unless `--apply` turns it back on.
		return hasFlag(flags, "", ["--check", "--stat", "--numstat", "--summary"]) && !hasFlag(flags, "", ["--apply"])
			? undefined
			: {
					scope: "worktree",
					what: "changes this checkout's files under the other session, files it may be editing too",
					instead:
						"Check it first with --check, then apply it in a worktree of your own or after the other session has committed.",
				};
	},
	bisect: args =>
		["reset", "log", "view", "visualize", "replay", "help"].includes(args[0] ?? "")
			? undefined
			: {
					scope: "worktree",
					what: "git bisect checks other commits out in this checkout and detaches HEAD under the other session",
					instead: WORKTREE_INSTEAD,
				},
	"checkout-index": args => {
		const { flags, words, afterDashes } = split("checkout-index", args);
		if (hasFlag(flags, "a", ["--all"]))
			return {
				scope: "worktree",
				what: "git checkout-index --all overwrites this checkout's files from the index, the other session's changes too",
				instead: RESTORE_INSTEAD,
			};
		const paths = [...words, ...(afterDashes ?? [])];
		return paths.length > 0
			? {
					scope: "paths",
					takes: false,
					paths,
					what: "checking out these paths from the index would overwrite the other session's changes",
					instead: RESTORE_INSTEAD,
				}
			: undefined;
	},
	"symbolic-ref": args => {
		const named = args.filter(arg => !arg.startsWith("-"));
		return named[0] === "HEAD" && named.length >= 2
			? {
					scope: "worktree",
					what: "git symbolic-ref HEAD <ref> switches this checkout's branch under the other session",
					instead: "To work on another branch, use a worktree of your own.",
				}
			: undefined;
	},
	worktree: args => {
		const [verb, ...paths] = split("worktree", args).words;
		if (verb !== "remove" && verb !== "move") return undefined;
		return {
			scope: "worktrees",
			paths: verb === "move" ? paths.slice(0, 1) : paths,
			what: `git worktree ${verb} takes a worktree's folder away from the session working in it`,
			instead: "Leave other sessions' worktrees alone; ask the user, or that session, when its work should end.",
		};
	},
};

const same = (a: string, b: string) => isInside(a, b) && isInside(b, a);

/**
 * Whether a path a git command names (relative to `cwd`) reaches a peer's work (`files`): a glob, pathspec magic or a
 * command substitution always, the top level or above always, else a file it changed at or under the path. A "take"
 * leaves out the files `own` changed too: the overlap notice already asks for a note before it.
 */
function endangers(
	path: string,
	cwd: string,
	toplevel: string,
	files: readonly string[],
	own: readonly string[],
	takes: boolean,
): boolean {
	if (path === "" || path.startsWith(":") || /[*?[$`]/.test(path)) return true;
	const target = normalizePath(path, cwd);
	if (isInside(toplevel, target)) return true;
	return files.some(file => isInside(file, target) && !(takes && own.some(mine => same(mine, file))));
}

function relative(file: string, toplevel: string): string {
	return file === toplevel ? "." : file.startsWith(`${toplevel}/`) ? file.slice(toplevel.length + 1) : file;
}

function peerLine(peer: CheckoutPeer, toplevel: string, files: boolean): string {
	const name = peer.id === null && !peer.device ? "a session hidden from agents" : `"${peer.title || "untitled"}"`;
	const where = peer.device ? `, run here for ${peer.device}` : "";
	const id = peer.id ? ` [${peer.id}]` : "";
	const changed =
		files && (peer.id || peer.device) && peer.files?.length
			? ` (changed lately: ${peer.files
					.slice(0, 8)
					.map(file => relative(file, toplevel))
					.join(", ")})`
			: "";
	const doing = files && peer.task ? ` (working on: ${peer.task})` : "";
	const elsewhere = peer.worktree && peer.worktree !== toplevel ? ` in ${peer.worktree}` : "";
	return `- ${name}${id}${where}${elsewhere}${doing}${changed}`;
}

function askLine(peers: CheckoutPeer[], canMessage: boolean): string {
	const id = peers.find(peer => peer.id)?.id;
	return canMessage && id
		? `To agree who does what (who commits which files, or that one of you waits until the other has committed), ask it: ompdesk_report {"to": "${id}", "kind": "question", "text": "…"}. Its answer comes back to you as a message.`
		: "To agree who does what, ask the user which session goes first.";
}

/** What the guard may ask of the file system: main's spelling of a path, whether a path is a folder, whether it exists. */
export interface CheckoutHost {
	realpath(path: string): string;
	isDirectory?(path: string): boolean;
	exists?(path: string): boolean;
	/** The files a shell glob (absolute) matches now; none when it cannot tell. */
	expand?(glob: string): string[];
}

type FsView = Partial<CheckoutHost>;

const NO_BRANCHES: ReadonlySet<string> = new Set();

/**
 * Why `command` (run in `cwd`) must not run while `peers` share this checkout, or undefined. `ownFiles` are the files
 * this session changed (absolute), named in the refusal so the agent can stage exactly those; `ownBranches` the
 * branches it created (it may delete those).
 */
export function checkoutRefusal(
	command: string,
	cwd: string,
	peers: CheckoutPeers,
	ownFiles: readonly string[],
	realpath?: (path: string) => string,
	isDirectory?: (path: string) => boolean,
	exists?: (path: string) => boolean,
	ownBranches: ReadonlySet<string> = NO_BRANCHES,
): string | undefined {
	return refusalFor(
		shellEffects(command, cwd, isDirectory),
		peers,
		ownFiles,
		{ realpath, isDirectory, exists },
		ownBranches,
	);
}

function refusalFor(
	effects: ShellEffects,
	peers: CheckoutPeers,
	ownFiles: readonly string[],
	fs: FsView,
	ownBranches: ReadonlySet<string>,
): string | undefined {
	const repoPeers = [...peers.worktree, ...peers.repo];
	if (repoPeers.length === 0) return undefined;
	for (const git of effects.git) {
		// A `cd` or `-C` through a symlink lands in main's spelling of the checkout too.
		const at =
			fs.realpath && !git.cwd.startsWith("\u0000") ? { ...git, cwd: canonicalPath(git.cwd, fs.realpath) } : git;
		const refusal = judge(at, peers, repoPeers, ownFiles, fs, ownBranches);
		if (refusal) return refusal;
	}
	const changes = changesOf(effects, fs.realpath, peers.toplevel);
	return (
		overwriteRefusal(changes.replaces, "from the shell", peers, ownFiles) ??
		overwriteRefusal(changes.deletes, "from the shell", peers, ownFiles, true)
	);
}

/** The files a command changes, in main's spelling: in place (`edits`), replaced whole or redirected into (`replaces`), removed (`deletes`). */
export interface ShellChanges {
	edits: string[];
	replaces: string[];
	deletes: string[];
}

/** What the parser leaves in front of a path after a `cd` it could not resolve. */
const UNRESOLVED = "/\u0000unresolvable/";

/**
 * `effects`' file changes in main's spelling, devices dropped. A path after a `cd` the parser could not resolve is
 * read from `base` (the checkout's top level: such a `cd` is most often `cd "$(git rev-parse --show-toplevel)"`); with
 * no `base` it is dropped.
 */
function changesOf(effects: ShellEffects, realpath?: (path: string) => string, base?: string): ShellChanges {
	const settle = (paths: string[]) =>
		paths.flatMap(path => {
			if (path.startsWith("/dev/")) return [];
			const resolved =
				path.startsWith(UNRESOLVED) && base ? normalizePath(path.slice(UNRESOLVED.length), base) : path;
			if (resolved.includes("\u0000")) return [];
			return [realpath ? canonicalPath(resolved, realpath) : resolved];
		});
	return {
		edits: settle(effects.edits),
		replaces: settle([...effects.writes, ...effects.replaces]),
		deletes: settle(effects.deletes),
	};
}

/**
 * The files `command` changes (redirects, `sed -i`, `cp`/`mv`/`rm`, `tee`, `dd of=`, `patch`, ...), read with
 * Autopilot's own parser. A session records them as its own like a file tool's writes: measured, two sessions each
 * wrote the shared file with `echo >`, and only a recorded write lets the other's guard see it. `touch`, `mkdir` and
 * `chmod` change no content and are not listed.
 */
export function shellChanges(
	command: string,
	cwd: string,
	realpath?: (path: string) => string,
	isDirectory?: (path: string) => boolean,
): ShellChanges {
	return changesOf(shellEffects(command, cwd, isDirectory), realpath);
}

/**
 * Why a `write` tool call (it replaces a file whole) must not run, or undefined: measured, two sessions changing one
 * file kept overwriting each other's uncommitted lines this way, while the edit tool applies only its own lines and
 * refuses an edit whose lines moved underneath.
 */
export function writeRefusal(
	paths: readonly string[],
	peers: CheckoutPeers,
	ownFiles: readonly string[],
): string | undefined {
	return overwriteRefusal(paths, "with the write tool", peers, ownFiles);
}

/** Why a file tool call must not run: it replaces a file another session changed whole (a write, a rename onto it) or deletes it. */
function fileToolRefusal(
	toolName: string,
	effects: readonly FileToolEffect[],
	peers: CheckoutPeers,
	ownFiles: readonly string[],
): string | undefined {
	const how = `with the ${toolName} tool`;
	const of = (kind: FileToolEffect["kind"]) =>
		effects.filter(effect => effect.kind === kind).map(effect => effect.path);
	return (
		overwriteRefusal(
			of("replace"),
			how,
			peers,
			ownFiles,
			false,
			toolName === "write" ? undefined : "Change its lines in place instead of replacing it whole.",
		) ?? overwriteRefusal(of("delete"), how, peers, ownFiles, true)
	);
}

/** A todo item as a peer shows it: one line, at most `CHECKOUT_TASK_MAX` characters; undefined when blank. */
export function oneLineTask(text: string): string | undefined {
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length > CHECKOUT_TASK_MAX ? `${line.slice(0, CHECKOUT_TASK_MAX - 1)}…` : line;
}

/**
 * The content of the first `in_progress` task of a todo list (stock's phases), one line; undefined when none.
 */
export function currentTask(
	phases: ReadonlyArray<{ tasks: ReadonlyArray<{ content: string; status: string }> }>,
): string | undefined {
	for (const phase of phases)
		for (const task of phase.tasks) if (task.status === "in_progress") return oneLineTask(task.content);
	return undefined;
}

const peerKey = (peer: CheckoutPeer) => peer.id ?? (peer.device ? `device:${peer.device}` : "hidden");

/**
 * `told` without the (file, peer) pairs whose file the peer no longer lists: once it committed the file, the pair
 * can be said again when it changes the file anew.
 */
function stillTold(told: ReadonlySet<string>, peers: CheckoutPeers): Set<string> {
	const present = new Set<string>();
	for (const peer of [...peers.worktree, ...peers.repo])
		for (const file of [...(peer.files ?? []), ...(peer.shared ?? [])]) present.add(`${file}\0${peerKey(peer)}`);
	return new Set([...told].filter(pair => present.has(pair)));
}

/** The files of `files` not yet told for `peer`; they count as told from now on. */
function untold(peer: CheckoutPeer, files: readonly string[], told: Set<string>): string[] {
	const fresh = files.filter(file => !told.has(`${file}\0${peerKey(peer)}`));
	for (const file of fresh) told.add(`${file}\0${peerKey(peer)}`);
	return fresh;
}

/** What the notice says about one scope's peers. */
const SCOPE_TEXT = {
	worktree: {
		edited: "Another session changed a file you just edited:",
		shared: "Another session also changed files you changed:",
	},
	repo: {
		edited:
			"A session in another worktree of this repository, on its own branch, changed a file you just edited. The two edits will conflict when the branches merge:",
		shared:
			"A session in another worktree of this repository, on its own branch, also changed files you changed. The two changes will conflict when the branches merge:",
	},
} as const;

function noticeAction(scope: "worktree" | "repo", reach: string[], noun: string): string {
	const notes = reach.map(id => `{"to": "${id}", "kind": "note", "text": …}`).join(" / ");
	const each = reach.length === 1 ? "that session" : "each of them";
	if (scope === "repo")
		return reach.length
			? `Tell ${each} before the branches meet, with one ompdesk_report ${notes}; use "kind": "question" instead when one of you should change course.`
			: "Tell the user, so one of you adapts before the branches meet.";
	return reach.length
		? `Keep your change to your own lines. Before you commit ${noun}, send ${each} one ompdesk_report ${notes}; use "kind": "question" instead when your change can break theirs.`
		: `Keep your change to your own lines, and tell the user before you commit ${noun}.`;
}

/**
 * The passive notice for a tool call, or undefined text. Forward: the call changes a file (`paths`, not a refused
 * `write`) that a peer changed too. Reverse: a peer started changing a file this session changed (`shared`), told at
 * the session's next call of any kind. A same-worktree peer's overlap asks for care; another worktree's only warns of
 * the merge ahead and never refuses. `told` holds the (file, peer) pairs already said; the returned `told` adds this
 * notice's and drops the pairs whose file the peer no longer lists, so each pair is said once per time it appears.
 */
export function overlapNotice(
	paths: readonly string[],
	peers: CheckoutPeers,
	told: ReadonlySet<string>,
): { text: string | undefined; told: Set<string> } {
	const next = stillTold(told, peers);
	const blocks: string[] = [];
	for (const [scope, list] of [
		["worktree", peers.worktree],
		["repo", peers.repo],
	] as const) {
		const edited: string[] = [];
		const shared: string[] = [];
		const reach: string[] = [];
		for (const peer of list) {
			const touched = untold(
				peer,
				(peer.files ?? []).filter(file => paths.some(path => isInside(file, path) && isInside(path, file))),
				next,
			);
			const also = untold(peer, peer.shared ?? [], next);
			const line = (files: string[]) =>
				`- ${peerLine({ ...peer, files: undefined }, peers.toplevel, true).slice(2)} also changed: ${files.map(file => relative(file, peers.toplevel)).join(", ")}`;
			if (touched.length > 0) edited.push(line(touched));
			if (also.length > 0) shared.push(line(also));
			if (touched.length + also.length > 0 && peer.id && peers.canMessage) reach.push(peer.id);
		}
		const block = (kind: "edited" | "shared", lines: string[]) =>
			lines.length === 0
				? []
				: [
						[
							"<shared-checkout-overlap>",
							SCOPE_TEXT[scope][kind],
							...lines,
							noticeAction(scope, reach, kind === "edited" ? "this file" : "these files"),
							"</shared-checkout-overlap>",
						].join("\n"),
					];
		blocks.push(...block("edited", edited), ...block("shared", shared));
	}
	return { text: blocks.length > 0 ? blocks.join("\n\n") : undefined, told: next };
}

const GLOB = /[*?[]/;

/** A shell glob as a pattern over whole absolute paths (case-insensitive where the file system is); `**` crosses folders, `*` and `?` do not, `**` plus `/` also matches no folder at all. */
function globPattern(glob: string): RegExp {
	const flags = foldsCase() ? "i" : "";
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		const close = char === "[" ? glob.indexOf("]", index + 2) : -1;
		if (char === "*" && glob[index + 1] === "*") {
			if (glob[index + 2] === "/") {
				source += "(?:.*/)?";
				index += 2;
			} else {
				source += ".*";
				index++;
			}
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (close > index) {
			source += glob.slice(index, close + 1).replace(/^\[!/, "[^");
			index = close;
		} else source += char.replace(/[.+^${}()|\\[\]]/g, "\\$&");
	}
	try {
		return new RegExp(`^${source}$`, flags);
	} catch {
		// A bracket class the pattern language rejects: fall back to the literal start of the glob.
		return new RegExp(`^${glob.slice(0, glob.search(GLOB)).replace(/[.+^${}()|\\[\]]/g, "\\$&")}`, flags);
	}
}

/**
 * Whether a shell command's `target` takes `file`: the very file or a glob matching it; a deletion (`rm -r`) also
 * takes every file below a folder it names.
 */
function reaches(target: string, file: string, deleting: boolean): boolean {
	if (!GLOB.test(target)) return isInside(file, target) && (deleting || isInside(target, file));
	const pattern = globPattern(target);
	const parts = file.split("/");
	for (let length = deleting ? 2 : parts.length; length <= parts.length; length++)
		if (pattern.test(parts.slice(0, length).join("/"))) return true;
	return false;
}

/** Files a build or a run writes again and again: two sessions' commands each writing `build.log` are no overwrite of work. */
const OUTPUT_FILE = /\.(log|out|tmp|pid|err)$/i;
const OUTPUT_FOLDERS = new Set([
	"dist",
	"coverage",
	".cache",
	"test-results",
	"playwright-report",
	"node_modules",
	".turbo",
	".next",
	"__pycache__",
]);
const isOutput = (path: string) => OUTPUT_FILE.test(path) || path.split("/").some(part => OUTPUT_FOLDERS.has(part));

function overwriteRefusal(
	paths: readonly string[],
	how: string,
	peers: CheckoutPeers,
	ownFiles: readonly string[],
	deleting = false,
	insteadWrite = "Change it with the edit tool: it applies only your lines and refuses an edit whose lines moved under you.",
): string | undefined {
	for (const path of paths) {
		const name = relative(path, peers.toplevel);
		if (isOutput(name)) continue;
		// Another worktree's sessions count by their files at the real place (a write aimed into their folder).
		const endangered = [
			...peers.worktree.filter(peer => peer.files?.some(file => reaches(path, file, deleting))),
			...peers.repo.filter(peer => peer.worktreeFiles?.some(file => reaches(path, file, deleting))),
		];
		if (endangered.length === 0) continue;
		return deleting
			? refusalText(
					`deleting ${name} ${how} would drop the other session's uncommitted changes in it`,
					"Delete only files you made; leave one the other session changed, or ask it to commit or remove it.",
					endangered,
					true,
					peers,
					ownFiles,
				)
			: refusalText(
					`writing ${name} whole ${how} would drop the other session's uncommitted changes to it`,
					insteadWrite,
					endangered,
					true,
					peers,
					ownFiles,
				);
	}
	return undefined;
}

function refusalText(
	what: string,
	instead: string,
	endangered: CheckoutPeer[],
	files: boolean,
	peers: CheckoutPeers,
	ownFiles: readonly string[],
): string {
	const own = ownFiles.length
		? ` Files you changed: ${ownFiles
				.slice(0, 12)
				.map(file => relative(file, peers.toplevel))
				.join(", ")}.`
		: "";
	return [
		`${CHECKOUT_REFUSAL_PREFIX}: ${what}.`,
		...endangered.map(peer => peerLine(peer, peers.toplevel, files)),
		`${instead}${own}`,
		askLine(endangered, peers.canMessage),
	].join("\n");
}

function judge(
	git: GitInvocation,
	peers: CheckoutPeers,
	repoPeers: CheckoutPeer[],
	ownFiles: readonly string[],
	fs: FsView,
	ownBranches: ReadonlySet<string>,
): string | undefined {
	const { toplevel } = peers;
	// An unresolvable cd counts as here.
	const unresolved = git.cwd.startsWith("\u0000");
	const cwd = unresolved ? toplevel : git.cwd;
	// A host that cannot tell reads every word as no file: a revision to move to, the conservative reading.
	const exists = (word: string) => fs.exists?.(normalizePath(word, cwd)) ?? false;
	const hazard = GIT_RULES[git.sub]?.(git.args, { exists, ownBranches });
	if (!hazard) return undefined;
	const here = unresolved || isInside(cwd, toplevel);
	// A run inside another session's worktree of the repository touches that worktree's files and index.
	const there = here ? [] : peers.repo.filter(peer => peer.worktree !== undefined && isInside(cwd, peer.worktree));
	// A run in another repository is none of these sessions' business. A worktree removal names its path, wherever git runs.
	if (hazard.scope !== "worktrees" && !here && there.length === 0) return undefined;
	let endangered: CheckoutPeer[];
	if (hazard.scope === "worktrees") {
		const targets = hazard.paths.map(path => normalizePath(path, cwd));
		endangered = [
			...peers.repo.filter(peer =>
				targets.some(target => peer.worktree !== undefined && isInside(peer.worktree, target)),
			),
			...(targets.some(target => isInside(toplevel, target)) ? peers.worktree : []),
		];
	} else if (hazard.scope === "repo") endangered = repoPeers;
	else if (hazard.scope === "worktree") endangered = here ? peers.worktree : there;
	else if (here)
		endangered = peers.worktree.filter(peer =>
			hazard.paths.some(path => endangers(path, cwd, toplevel, peer.files ?? [], ownFiles, hazard.takes)),
		);
	else
		endangered = there.filter(peer =>
			hazard.paths.some(path =>
				endangers(path, cwd, peer.worktree ?? toplevel, peer.worktreeFiles ?? [], [], false),
			),
		);
	if (endangered.length === 0) return undefined;
	const command = (git.label ?? `git ${[git.sub, ...git.args].join(" ")}`).slice(0, 120);
	return refusalText(
		`\`${command}\`: ${hazard.what}`,
		hazard.instead,
		endangered,
		hazard.scope === "paths" || hazard.scope === "worktree",
		peers,
		ownFiles,
	);
}

/**
 * The per-turn section naming the other live sessions in this worktree and repository, or undefined when the session
 * works alone. It holds only names and ids (no changed files), so it stays the same turn after turn and the prompt
 * cache holds; the guard's refusal names the files.
 */
export function checkoutSection(peers: CheckoutPeers | undefined): string | undefined {
	if (!peers || (peers.worktree.length === 0 && peers.repo.length === 0)) return undefined;
	const lines = ["<shared-checkout>"];
	if (peers.worktree.length > 0) {
		lines.push(
			"Other sessions work in this same checkout right now (the same files, index, branch and build output):",
		);
		for (const peer of peers.worktree) lines.push(peerLine(peer, peers.toplevel, false));
	}
	if (peers.repo.length > 0) {
		lines.push(
			"Other sessions work in other worktrees of this repository (they share its stash, branches and refs):",
		);
		for (const peer of peers.repo) lines.push(peerLine(peer, peers.toplevel, false));
	}
	lines.push(
		peers.worktree.length > 0
			? "- Stage and commit only files you changed, by name (git add -- <file>, git commit -m <message> -- <file>): the index is shared, so a commit without paths takes what they staged. Never git add -A or ., commit -a, stash, reset, clean, switch, or checkout/restore of files you did not change: a guard refuses them while others work here. Change a file they also work on with the edit tool, never by writing it whole (write, a shell `>`). Run formatters and fixers on your own files only (prettier --write <file>), never on the whole tree."
			: "- Never use git stash, and never delete or move a branch you did not create: a guard refuses them while others work in this repository.",
	);
	const reachable = [...peers.worktree, ...peers.repo].filter(peer => peer.id);
	if (peers.canMessage && reachable.length > 0) {
		if (peers.worktree.length > 0)
			lines.push(
				'- Before a step that changes what they work on (a commit, a dependency install, a rebuild, restarting a dev server they may use), send each of them one short note: ompdesk_report {"to": <id>, "kind": "note", "text": …}. One note per step, never a running commentary.',
			);
		lines.push(
			'- When you need one of them to commit, hold off or hand over a file, ask: ompdesk_report {"to": <id>, "kind": "question", "text": …}; the answer comes as a message. Their notes reach you the same way: answer their questions, and leave their files alone.',
		);
	} else lines.push("- Leave their files alone; ask the user when you need one of them to go first.");
	lines.push("</shared-checkout>");
	return lines.join("\n");
}

const fileList = (value: unknown, base: string): string[] | undefined =>
	Array.isArray(value)
		? value.filter((file): file is string => typeof file === "string").map(file => normalizePath(file, base))
		: undefined;

function peerList(value: unknown): CheckoutPeer[] {
	if (!Array.isArray(value)) throw new Error(`${CHECKOUT_PEERS_SET} needs peer lists`);
	return value.flatMap(item => {
		if (typeof item !== "object" || item === null) return [];
		const peer = item as Record<string, unknown>;
		const task = typeof peer.task === "string" ? oneLineTask(peer.task) : undefined;
		const shared = fileList(peer.shared, "/");
		const files = fileList(peer.files, "/");
		const worktreeFiles = fileList(peer.worktreeFiles, "/");
		return [
			{
				id: typeof peer.id === "string" ? peer.id : null,
				title: typeof peer.title === "string" ? peer.title.slice(0, 200) : "",
				...(typeof peer.device === "string" ? { device: peer.device } : {}),
				...(typeof peer.sessionPath === "string" ? { sessionPath: peer.sessionPath } : {}),
				...(typeof peer.worktree === "string" ? { worktree: normalizePath(peer.worktree, "/") } : {}),
				...(task ? { task } : {}),
				...(shared ? { shared } : {}),
				...(files ? { files } : {}),
				...(worktreeFiles ? { worktreeFiles } : {}),
			},
		];
	});
}

/** What main last told this session about the others in its checkout (`checkout_peers_set`). */
export class CheckoutPeersState {
	#peers: CheckoutPeers | undefined;

	/** Undefined while the session works alone. */
	get peers(): CheckoutPeers | undefined {
		return this.#peers;
	}

	/** Take main's `CheckoutPeers`; true when what the session knows changed (the GUI is told then). */
	set(params: unknown): boolean {
		const record = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
		if (typeof record.toplevel !== "string" || typeof record.commonDir !== "string")
			throw new Error(`${CHECKOUT_PEERS_SET} needs {toplevel, commonDir, worktree, repo, canMessage}`);
		const next: CheckoutPeers = {
			toplevel: normalizePath(record.toplevel, "/"),
			commonDir: normalizePath(record.commonDir, "/"),
			worktree: peerList(record.worktree),
			repo: peerList(record.repo),
			canMessage: record.canMessage === true,
		};
		const before = JSON.stringify(this.#peers ?? null);
		this.#peers = next.worktree.length > 0 || next.repo.length > 0 ? next : undefined;
		return JSON.stringify(this.#peers ?? null) !== before;
	}
}

/**
 * `path` (absolute) in the spelling main compares against: the real path of its nearest existing ancestor, the rest
 * as written (a file a write is about to create does not exist yet). Main resolves top levels with `realpath`, and a
 * session's own cwd may run through a symlink (macOS `/var/folders` is `/private/var/folders`); without this the
 * guard took a git run there for one in another repository and judged nothing.
 */
export function canonicalPath(path: string, realpath: (path: string) => string): string {
	const parts = normalizePath(path, "/").split("/");
	for (let cut = parts.length; cut > 1; cut--) {
		const head = parts.slice(0, cut).join("/");
		try {
			return normalizePath([realpath(head), ...parts.slice(cut)].join("/"), "/");
		} catch {
			// Not there (yet): try its parent.
		}
	}
	return normalizePath(path, "/");
}

/** What a tool call did: refused with the reason the model reads, or allowed with a notice for it and whether it added a file to the session's own. */
export type CallVerdict = { block: string } | { notice?: string; gained: boolean };

const URL_PATH = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** The most files one shell glob adds to the claims (a glob over a whole tree is refused or noticed, never a thousand claims). */
const GLOB_MATCHES_MAX = 500;

/** What `git` runs in a call do to this session's claims: files they change, files they make clean (a commit, a restore), a reason for main to look now. */
interface GitWork {
	claims: string[];
	drops: string[];
	refresh: boolean;
}

/** The git subcommands after which the files this session changed may be clean or different: main reads at once. */
const GIT_REFRESHING = new Set([
	"commit",
	"restore",
	"checkout",
	"reset",
	"stash",
	"clean",
	"switch",
	"merge",
	"pull",
	"rebase",
	"am",
	"cherry-pick",
	"revert",
	"rm",
	"mv",
	"apply",
]);

/** What one git run does to files: the paths it names that it changes (`mv`, `rm`, `checkout <rev> -- p`, `restore --source`) or makes clean (`commit -- p`, `restore p`, `checkout -- p`, `stash push -- p`). */
function gitWork(git: GitInvocation, base: string, fs: FsView): GitWork {
	const cwd = git.cwd.startsWith("\u0000") ? base : git.cwd;
	const absolute = (word: string) => normalizePath(word, cwd);
	const { flags, words, afterDashes } = split(git.sub, git.args);
	const named = [...words, ...(afterDashes ?? [])].filter(word => word !== "" && !word.startsWith(":"));
	const work: GitWork = { claims: [], drops: [], refresh: GIT_REFRESHING.has(git.sub) };
	if (git.sub === "mv" && words.length >= 2) {
		const dest = absolute(words[words.length - 1]);
		const into = fs.isDirectory?.(dest) === true;
		for (const source of words.slice(0, -1)) {
			work.claims.push(absolute(source));
			work.claims.push(into ? normalizePath(source.split("/").pop() ?? source, dest) : dest);
		}
	} else if (git.sub === "rm" && !hasFlag(flags, "", ["--cached"])) work.claims.push(...named.map(absolute));
	else if (git.sub === "checkout" && afterDashes)
		(words.length > 0 ? work.claims : work.drops).push(...afterDashes.map(absolute));
	else if (git.sub === "restore") {
		if (hasFlag(flags, "s", ["--source"])) work.claims.push(...named.map(absolute));
		else if (!hasFlag(flags, "S", ["--staged"]) || hasFlag(flags, "W", ["--worktree"]))
			work.drops.push(...named.map(absolute));
	} else if (git.sub === "commit" && !hasFlag(flags, "a", ["--all"])) work.drops.push(...named.map(absolute));
	else if (git.sub === "stash" && afterDashes) work.drops.push(...afterDashes.map(absolute));
	return work;
}

/** The branches a git run creates (`branch <name>`, `checkout -b`, `switch -c`, `worktree add -b`). */
function createdBranches(git: GitInvocation): string[] {
	const { args } = git;
	const after = (flags: string[]) => {
		const at = args.findIndex(arg => flags.includes(arg));
		return at >= 0 && args[at + 1] !== undefined ? [args[at + 1]] : [];
	};
	if (git.sub === "checkout") return after(["-b", "-B"]);
	if (git.sub === "switch") return after(["-c", "-C", "--create", "--force-create"]);
	if (git.sub === "worktree" && args[0] === "add") return after(["-b", "-B"]);
	if (git.sub === "branch") {
		const changing = args.some(
			arg =>
				/^--(delete|move|force|copy|list|show-current)$/.test(arg) ||
				/^-[a-zA-Z]*[dDmMfcClvar][a-zA-Z]*$/.test(arg),
		);
		const name = split("branch", args).words[0];
		return !changing && name ? [name] : [];
	}
	return [];
}

/** The files a call itself reports it changed (`ast_edit` applied through `resolve`, an lsp rename), as written; the tool result is the only place that says. */
export function reportedFiles(toolName: string, details: unknown, text: string): string[] {
	const found: string[] = [];
	const walk = (value: unknown, depth: number) => {
		if (depth > 6 || typeof value !== "object" || value === null) return;
		const record = value as Record<string, unknown>;
		if (record.applied === true && Array.isArray(record.files))
			found.push(...record.files.filter((file): file is string => typeof file === "string"));
		for (const child of Object.values(record)) walk(child, depth + 1);
	};
	walk(details, 0);
	if (toolName === "lsp")
		for (const line of text.split("\n")) {
			const edited = /^\s*(?:Applied \d+ edit\(s\) to|Created|Deleted) (.+)$/.exec(line);
			const renamed = /^\s*Renamed (.+) → (.+)$/.exec(line);
			if (edited) found.push(edited[1].trim());
			else if (renamed) found.push(renamed[1].trim(), renamed[2].trim());
		}
	return found;
}

/** What a tool call reported back (stock's `tool_result`). */
export interface CallOutcome {
	isError: boolean;
	/** `details.async.jobId` of a bash call that went to the background: the command still runs, so its claims stay pending until the job ends. */
	job?: string;
	/** Files the result says it changed (`reportedFiles`), as written. */
	reported?: readonly string[];
}

/** What the guard keeps of a pending call beside its claims: where it ran, and the overlap pairs its notice said. */
interface CallNotes {
	cwd: string;
	realpath: (path: string) => string;
	/** Given back to `told` when the call fails, so the next call says them again (stock drops a hook's context with an error result). */
	told: string[];
}

/**
 * The guard of one omp: every tool call goes through `call`, which judges it against the peers, records what it
 * changes as the session's claims (`claims`, the claim state machine of checkout-claims.ts) and returns the notice for
 * the model; it remembers which (file, peer) pairs it already told and which branches the session created.
 */
export class CheckoutLedger {
	readonly claims = new ClaimBook<CallNotes>();
	#told = new Set<string>();
	/** The branches this session created: it may delete or move those. */
	#branches = new Set<string>();

	/**
	 * One tool call (`cwd` is the session's folder). A refused call claims nothing and leaves the notice it would have
	 * carried for the next call; the refusal text reaches the model on its own.
	 */
	call(
		toolName: string,
		input: unknown,
		cwd: string,
		peers: CheckoutPeers | undefined,
		host: CheckoutHost,
		toolCallId?: string,
		owner = "",
	): CallVerdict {
		const args = typeof input === "object" && input !== null ? input : {};
		let touched: string[] = [];
		let git: GitInvocation[] = [];
		let at = cwd;
		if (toolName === "bash" || toolName === "eval") {
			const command = toolName === "bash" && "command" in args ? args.command : undefined;
			const folder = "cwd" in args && typeof args.cwd === "string" ? args.cwd : ".";
			at = canonicalPath(normalizePath(folder, cwd), host.realpath);
			const effects =
				typeof command === "string"
					? shellEffects(command, at, host.isDirectory)
					: toolName === "eval"
						? evalEffects(input, at)
						: undefined;
			if (effects) {
				const refusal = peers ? refusalFor(effects, peers, this.claims.files, host, this.#branches) : undefined;
				if (refusal) return { block: refusal };
				const changes = changesOf(effects, host.realpath, peers?.toplevel ?? at);
				touched = [...changes.edits, ...changes.replaces, ...changes.deletes];
				git = effects.git;
			}
		} else {
			const effects = fileToolEffects(toolName, input)
				.filter(effect => !URL_PATH.test(effect.path))
				.map(effect => ({ ...effect, path: canonicalPath(normalizePath(effect.path, cwd), host.realpath) }));
			const refusal = peers ? fileToolRefusal(toolName, effects, peers, this.claims.files) : undefined;
			if (refusal) return { block: refusal };
			touched = effects.map(effect => effect.path);
		}
		const work = git.map(run => gitWork(run, peers?.toplevel ?? at, host));
		for (const run of git) for (const name of createdBranches(run)) this.#branches.add(name);
		// A glob names files only the shell knows: a notice never reads it, and a claim takes what it matches now (before the command runs).
		const noticed = touched.filter(path => !GLOB.test(path));
		const matched =
			toolName === "bash" || toolName === "eval"
				? touched
						.filter(path => GLOB.test(path))
						.flatMap(path => (host.expand?.(path) ?? []).slice(0, GLOB_MATCHES_MAX))
				: [];
		let notice: string | undefined;
		let told: string[] = [];
		// A call without peers (they dropped out for one call) leaves what was said alone: it is said once, not again.
		if (peers) {
			const said = overlapNotice(noticed, peers, this.#told);
			told = [...said.told].filter(pair => !this.#told.has(pair));
			this.#told = said.told;
			notice = said.text;
		}
		// A preview (`ast_edit`) writes nothing; the result of the call that applies it names the files.
		const claims = [
			...(toolName === "ast_edit" ? [] : [...noticed, ...matched.map(path => canonicalPath(path, host.realpath))]),
			...work.flatMap(item => item.claims).map(path => canonicalPath(path, host.realpath)),
		].filter(path => claimable(path, peers, canonicalPath(cwd, host.realpath)));
		// The hook runs before the tool: until it reports back, git may not show the change yet.
		const gained = this.claims.begin({
			owner,
			...(toolCallId === undefined ? {} : { id: toolCallId }),
			paths: claims,
			keepsOnError: toolName === "bash" || toolName === "eval",
			drops: work
				.flatMap(item => item.drops)
				.filter(path => !GLOB.test(path))
				.map(path => canonicalPath(path, host.realpath)),
			refresh: work.some(item => item.refresh),
			extra: { cwd, realpath: host.realpath, told },
		});
		return { notice, gained };
	}

	/**
	 * The call `toolCallId` of `owner` reported back (stock's `tool_result`); the files its result names join its
	 * claims (`ClaimBook.end`). True when main should read now.
	 */
	settle(toolCallId: string, owner = "", outcome: CallOutcome = { isError: false }): boolean {
		const notes = this.claims.extra(owner, toolCallId);
		if (!notes) return false;
		const reported = (outcome.reported ?? [])
			.filter(file => !URL_PATH.test(file))
			.map(file => canonicalPath(normalizePath(file, notes.cwd), notes.realpath))
			.filter(file => claimable(file, undefined, canonicalPath(notes.cwd, notes.realpath)));
		const { changed } = this.claims.end(owner, toolCallId, { ...outcome, reported });
		if (outcome.isError) this.#forget(notes);
		return changed;
	}

	/** `owner`'s run ended (`ClaimBook.agentEnded`): the notices of the calls it settles never reached the model. */
	settleAll(owner: string): boolean {
		const { changed, ended } = this.claims.agentEnded(owner);
		for (const notes of ended) this.#forget(notes);
		return changed;
	}

	#forget(notes: CallNotes): void {
		for (const pair of notes.told) this.#told.delete(pair);
	}
}

/**
 * Whether a path can be a claim: a file of the worktree (or of the session's own folder, which may itself sit under
 * a scratch prefix such as macOS's `/var/folders`), never git's own folder, a glob, or scratch output elsewhere. With
 * peers known, a path outside the worktree is none of this checkout's business.
 */
function claimable(path: string, peers: CheckoutPeers | undefined, cwd: string): boolean {
	if (GLOB.test(path) || hasGitSegment(path)) return false;
	if (isInside(path, cwd) || (peers !== undefined && isInside(path, peers.toplevel))) return true;
	return peers === undefined && !isScratch(path);
}

/** What an `eval` cell's code visibly writes or removes (a literal path handed to a file function, or the `write()` helper). */
function evalEffects(input: unknown, cwd: string): ShellEffects {
	const found: ShellEffects = { git: [], writes: [], edits: [], replaces: [], deletes: [] };
	const walk = (value: unknown, depth: number) => {
		if (typeof value === "string") {
			for (const change of inlineCodeEffects(value, true))
				found[`${change.kind}s`].push(normalizePath(change.path, cwd));
		} else if (depth < 4 && typeof value === "object" && value !== null)
			for (const child of Object.values(value)) walk(child, depth + 1);
	};
	walk(input, 0);
	return found;
}
