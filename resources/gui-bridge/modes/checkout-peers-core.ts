/**
 * Rules for sessions that share a checkout (contracts: checkout-peers-contracts.ts): the prompt section that names the
 * other sessions and how to reach them, the `tool_call` guard that refuses a step which would take, overwrite or hide
 * another session's work, and the notices that tell a session of an overlap. Pure; the bridge module
 * (checkout-peers.ts) and the GUI's tests call it.
 *
 * The guard reads `bash` with Autopilot's own shell parser (`shellEffects`) and judges each git run by one table
 * (`GIT_RULES`): a repository-wide step (stash, deleting or moving a branch) is refused while any other session works
 * in any worktree of the repository; a worktree step (switching or resetting the checkout, cleaning, bulk staging,
 * `commit -a`, a commit without paths, merge, pull, rebase, cherry-pick, revert, am, apply) while another session
 * works in the same worktree; a step on named paths only when a path is broad (`.`, a directory, a glob) or names a
 * file another session changed; removing or moving a worktree another session works in. Replacing or deleting a file
 * another session changed (a shell redirect, `cp`/`mv`/`rm`/`tee`/`dd`, the `write` tool) is refused too. A session
 * working alone is never judged; a session in another worktree is never refused over files, only warned of the merge.
 */
import {
	fileToolPaths,
	type GitInvocation,
	isInside,
	normalizePath,
	type ShellEffects,
	shellEffects,
} from "./autopilot-guard-core";
import {
	CHECKOUT_FILES_MAX,
	CHECKOUT_PEERS_SET,
	CHECKOUT_REFUSAL_PREFIX,
	CHECKOUT_TASK_MAX,
	type CheckoutPeer,
	type CheckoutPeers,
} from "./checkout-peers-contracts";

/** What one git run does to shared state, before knowing who else works here. */
type Hazard =
	| { scope: "repo" | "worktree"; what: string; instead: string }
	| { scope: "paths" | "worktrees"; paths: string[]; what: string; instead: string };

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
};

/** `args` split into flags and the words that are not flags or flag values; everything after `--` is a word. */
function split(sub: string, args: string[]): { flags: string[]; words: string[]; afterDashes: string[] | null } {
	const flags: string[] = [];
	const words: string[] = [];
	const valued = VALUE_FLAGS[sub];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") return { flags, words, afterDashes: args.slice(index + 1) };
		if (arg.startsWith("-") && arg !== "-") {
			flags.push(arg);
			if (valued?.includes(arg)) index++;
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
const GIT_RULES: Record<string, (args: string[]) => Hazard | undefined> = {
	stash: args =>
		args[0] === "list" || args[0] === "show"
			? undefined
			: {
					scope: "repo",
					what: "git stash is one stack for every worktree of this repository: another session's stash and yours mix, and a pop can apply theirs",
					instead: "Commit your work in progress to your branch instead: git commit -- <your files>.",
				},
	branch: args =>
		args.some(arg => /^(--delete|--move|--force|--copy)$/.test(arg) || /^-[a-zA-Z]*[dDmMfcC][a-zA-Z]*$/.test(arg))
			? {
					scope: "repo",
					what: "deleting, moving or force-setting a branch changes refs every worktree of this repository shares",
					instead: "Leave branches you did not create alone; ask whoever made one.",
				}
			: undefined,
	add: args => {
		const { flags, words, afterDashes } = split("add", args);
		const named = [...words, ...(afterDashes ?? [])];
		if (hasFlag(flags, "Au", ["--all", "--update", "--pathspec-from-file"]))
			return {
				scope: "paths",
				// Without a path, -A and -u take the whole tree whatever the folder (":/" is git's own "from the top").
				paths: named.length > 0 ? named : [":/"],
				what: "bulk staging would take the other session's changes too",
				instead: STAGE_INSTEAD,
			};
		return {
			scope: "paths",
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
		const paths = [...words, ...(afterDashes ?? [])];
		// Without paths a commit takes whatever the shared index holds: measured, another session's `git add` landed in
		// this session's commit. With paths git commits only those (`--only`, its default).
		return paths.length > 0
			? { scope: "paths", paths, what: "committing these paths would take the other session's changes", instead }
			: {
					scope: "worktree",
					what: "a commit without paths takes everything staged in this checkout's shared index, files the other session staged too",
					instead,
				};
	},
	checkout: args => {
		const { words, afterDashes } = split("checkout", args);
		if (afterDashes)
			return {
				scope: "paths",
				paths: afterDashes,
				what: "checking out these paths would overwrite the other session's changes",
				instead: RESTORE_INSTEAD,
			};
		const broad = words.filter(word => word === "." || /[*?[]/.test(word));
		if (broad.length > 0)
			return {
				scope: "paths",
				paths: broad,
				what: "checking out the whole tree would overwrite the other session's changes",
				instead: RESTORE_INSTEAD,
			};
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
			paths: [...words, ...(afterDashes ?? [])],
			what: "restoring these paths would overwrite the other session's changes",
			instead: RESTORE_INSTEAD,
		};
	},
	reset: args => {
		const { flags, words, afterDashes } = split("reset", args);
		if (hasFlag(flags, "", ["--hard", "--merge", "--keep"]))
			return {
				scope: "worktree",
				what: "git reset --hard throws away every uncommitted change in this checkout, the other session's too",
				instead: RESTORE_INSTEAD,
			};
		const paths = [...words.filter(word => !REV.test(word)), ...(afterDashes ?? [])];
		return paths.length > 0
			? {
					scope: "paths",
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
	clean: args =>
		hasFlag(
			args.filter(arg => arg.startsWith("-")),
			"f",
			["--force"],
		)
			? {
					scope: "worktree",
					what: "git clean deletes untracked files in this checkout, the other session's new files too",
					instead: "Delete the untracked files you made, by name.",
				}
			: undefined,
	rm: args => {
		const { words, afterDashes } = split("rm", args);
		return {
			scope: "paths",
			paths: [...words, ...(afterDashes ?? [])],
			what: "removing these paths would delete the other session's work",
			instead: "Remove only files you made, by name.",
		};
	},
	mv: args => {
		const { words } = split("mv", args);
		return {
			scope: "paths",
			paths: words,
			what: "moving these paths would move files the other session works on",
			instead: "Move only files you made.",
		};
	},
	merge: args =>
		finishing(args)
			? undefined
			: {
					scope: "worktree",
					what: "git merge rewrites this checkout's files, index and HEAD under the other session, and a conflict leaves markers in files it may be editing",
					instead: WORKTREE_INSTEAD,
				},
	pull: () => ({
		scope: "worktree",
		what: "git pull merges or rebases the remote's commits into this checkout, rewriting files under the other session too",
		instead:
			"git fetch is safe here; merge or rebase in a worktree of your own, or after the other session has committed.",
	}),
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
		finishing(args)
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
					what: "git apply changes this checkout's files under the other session, files it may be editing too",
					instead:
						"Check it first with git apply --check, then apply it in a worktree of your own or after the other session has committed.",
				};
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

/** Whether a path a git command names (relative to `cwd`) reaches `peer`'s work: a glob or pathspec magic always, the top level or above always, else a file it changed at or under the path. */
function endangers(path: string, cwd: string, toplevel: string, peer: CheckoutPeer): boolean {
	if (path === "" || path.startsWith(":") || /[*?[]/.test(path)) return true;
	const target = normalizePath(path, cwd);
	if (isInside(toplevel, target)) return true;
	return peer.files?.some(file => isInside(file, target)) === true;
}

function relative(file: string, toplevel: string): string {
	return file.startsWith(`${toplevel}/`) ? file.slice(toplevel.length + 1) : file;
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

/**
 * Why `command` (run in `cwd`) must not run while `peers` share this checkout, or undefined. `ownFiles` are the files
 * this session changed (absolute), named in the refusal so the agent can stage exactly those.
 */
export function checkoutRefusal(
	command: string,
	cwd: string,
	peers: CheckoutPeers,
	ownFiles: readonly string[],
	realpath?: (path: string) => string,
	isDirectory?: (path: string) => boolean,
): string | undefined {
	return refusalFor(shellEffects(command, cwd, isDirectory), peers, ownFiles, realpath);
}

function refusalFor(
	effects: ShellEffects,
	peers: CheckoutPeers,
	ownFiles: readonly string[],
	realpath?: (path: string) => string,
): string | undefined {
	const repoPeers = [...peers.worktree, ...peers.repo];
	if (repoPeers.length === 0) return undefined;
	for (const git of effects.git) {
		// A `cd` or `-C` through a symlink lands in main's spelling of the checkout too.
		const at = realpath && !git.cwd.startsWith("\u0000") ? { ...git, cwd: canonicalPath(git.cwd, realpath) } : git;
		const refusal = judge(at, peers, repoPeers, ownFiles);
		if (refusal) return refusal;
	}
	const changes = changesOf(effects, realpath);
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

/** `effects`' file changes in main's spelling, devices and paths a failed `cd` left unresolved dropped. */
function changesOf(effects: ShellEffects, realpath?: (path: string) => string): ShellChanges {
	const settle = (paths: string[]) =>
		paths
			.filter(path => !path.startsWith("/dev/") && !path.includes("\u0000"))
			.map(path => (realpath ? canonicalPath(path, realpath) : path));
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

/** A shell glob as a case-insensitive pattern over whole absolute paths; `**` crosses folders, `*` and `?` do not. */
function globPattern(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		const close = char === "[" ? glob.indexOf("]", index + 2) : -1;
		if (char === "*" && glob[index + 1] === "*") {
			source += ".*";
			index++;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (close > index) {
			source += glob.slice(index, close + 1).replace(/^\[!/, "[^");
			index = close;
		} else source += char.replace(/[.+^${}()|\\[\]]/g, "\\$&");
	}
	try {
		return new RegExp(`^${source}$`, "i");
	} catch {
		// A bracket class the pattern language rejects: fall back to the literal start of the glob.
		return new RegExp(`^${glob.slice(0, glob.search(GLOB)).replace(/[.+^${}()|\\[\]]/g, "\\$&")}`, "i");
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

function overwriteRefusal(
	paths: readonly string[],
	how: string,
	peers: CheckoutPeers,
	ownFiles: readonly string[],
	deleting = false,
): string | undefined {
	for (const path of paths) {
		const endangered = peers.worktree.filter(peer => peer.files?.some(file => reaches(path, file, deleting)));
		if (endangered.length === 0) continue;
		const name = relative(path, peers.toplevel);
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
					"Change it with the edit tool: it applies only your lines and refuses an edit whose lines moved under you.",
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
): string | undefined {
	const { toplevel } = peers;
	const hazard = GIT_RULES[git.sub]?.(git.args);
	if (!hazard) return undefined;
	// A git run in another repository (cd elsewhere, -C) is none of these sessions' business; an unresolvable cd counts as here. A worktree removal names its path, wherever git runs.
	if (hazard.scope !== "worktrees" && !git.cwd.startsWith("\u0000") && !isInside(git.cwd, toplevel)) return undefined;
	const cwd = git.cwd.startsWith("\u0000") ? toplevel : git.cwd;
	let endangered: CheckoutPeer[];
	if (hazard.scope === "paths")
		endangered = peers.worktree.filter(peer => hazard.paths.some(path => endangers(path, cwd, toplevel, peer)));
	else if (hazard.scope === "worktrees") {
		const targets = hazard.paths.map(path => normalizePath(path, cwd));
		endangered = [
			...peers.repo.filter(peer =>
				targets.some(target => peer.worktree !== undefined && isInside(peer.worktree, target)),
			),
			...(targets.some(target => isInside(toplevel, target)) ? peers.worktree : []),
		];
	} else endangered = hazard.scope === "repo" ? repoPeers : peers.worktree;
	if (endangered.length === 0) return undefined;
	const command = `git ${[git.sub, ...git.args].join(" ")}`.slice(0, 120);
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

function peerList(value: unknown): CheckoutPeer[] {
	if (!Array.isArray(value)) throw new Error(`${CHECKOUT_PEERS_SET} needs peer lists`);
	return value.flatMap(item => {
		if (typeof item !== "object" || item === null) return [];
		const peer = item as Record<string, unknown>;
		const task = typeof peer.task === "string" ? oneLineTask(peer.task) : undefined;
		return [
			{
				id: typeof peer.id === "string" ? peer.id : null,
				title: typeof peer.title === "string" ? peer.title.slice(0, 200) : "",
				...(typeof peer.device === "string" ? { device: peer.device } : {}),
				...(typeof peer.sessionPath === "string" ? { sessionPath: peer.sessionPath } : {}),
				...(typeof peer.worktree === "string" ? { worktree: normalizePath(peer.worktree, "/") } : {}),
				...(task ? { task } : {}),
				...(Array.isArray(peer.shared)
					? {
							shared: peer.shared
								.filter((file): file is string => typeof file === "string")
								.slice(0, CHECKOUT_FILES_MAX)
								.map(file => normalizePath(file, "/")),
						}
					: {}),
				...(Array.isArray(peer.files)
					? {
							files: peer.files
								.filter((file): file is string => typeof file === "string")
								.slice(0, CHECKOUT_FILES_MAX)
								.map(file => normalizePath(file, "/")),
						}
					: {}),
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

/** `files` with `added` moved to the front, at most `max`. */
export function rememberFiles(files: readonly string[], added: readonly string[], max: number): string[] {
	const fresh = [...new Set(added)];
	return [...fresh, ...files.filter(file => !fresh.includes(file))].slice(0, max);
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

/** What the ledger needs from the file system: main's spelling of a path, and whether a path is a folder. */
export interface CheckoutHost {
	realpath(path: string): string;
	isDirectory?(path: string): boolean;
}

const URL_PATH = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * The files this session's agents changed (its claims, which main reads through `checkout_status`) and which
 * (file, peer) pairs it was already told of. Every tool call goes through `call`: it judges the call against the
 * peers, records what the call changes as the session's own, and returns the notice for the model.
 */
export class CheckoutLedger {
	#files: string[] = [];
	#told = new Set<string>();
	#stamps = new Map<string, number>();
	#seq = 0;
	/** The files each call that has not reported back yet claimed, by tool call id. */
	#pending = new Map<string, string[]>();

	/** The files this session changed, newest first. */
	get files(): readonly string[] {
		return this.#files;
	}

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
	): CallVerdict {
		const args = typeof input === "object" && input !== null ? input : {};
		let touched: string[] = [];
		if (toolName === "bash") {
			const command = "command" in args ? args.command : undefined;
			if (typeof command === "string") {
				const folder = "cwd" in args && typeof args.cwd === "string" ? args.cwd : ".";
				const at = canonicalPath(normalizePath(folder, cwd), host.realpath);
				const effects = shellEffects(command, at, host.isDirectory);
				const refusal = peers ? refusalFor(effects, peers, this.#files, host.realpath) : undefined;
				if (refusal) return { block: refusal };
				const changes = changesOf(effects, host.realpath);
				touched = [...changes.edits, ...changes.replaces, ...changes.deletes];
			}
		} else {
			touched = fileToolPaths(toolName, input)
				.filter(file => !URL_PATH.test(file))
				.map(file => canonicalPath(normalizePath(file, cwd), host.realpath));
			const refusal = peers && toolName === "write" ? writeRefusal(touched, peers, this.#files) : undefined;
			if (refusal) return { block: refusal };
		}
		// A glob names files only the shell knows; it can be refused above but never claimed.
		const paths = touched.filter(path => !GLOB.test(path));
		let notice: string | undefined;
		if (peers) {
			const said = overlapNotice(paths, peers, this.#told);
			this.#told = said.told;
			notice = said.text;
		} else this.#told = new Set();
		const had = new Set(this.#files);
		const gained = paths.some(path => !had.has(path));
		if (paths.length > 0) {
			this.#files = rememberFiles(this.#files, paths, CHECKOUT_FILES_MAX);
			for (const path of paths) this.#stamps.set(path, ++this.#seq);
			for (const path of this.#stamps.keys()) if (!this.#files.includes(path)) this.#stamps.delete(path);
			// The hook runs before the tool: until it reports back, git may not show the change yet.
			if (toolCallId !== undefined) this.#pending.set(toolCallId, paths);
		}
		return { notice, gained };
	}

	/** Each file's stamp: the number of the latest call that changed it, so main can retire exactly what it saw. */
	stamp(file: string): number {
		return this.#stamps.get(file) ?? 0;
	}

	/**
	 * The call `toolCallId` reported back (stock's `tool_result`): its files are written now. Their stamps move on, so a
	 * retirement main decided from a read taken while the call ran matches nothing. True when it had claimed files (the
	 * caller tells main, which then reads the written change).
	 */
	settle(toolCallId: string): boolean {
		const paths = this.#pending.get(toolCallId);
		if (!paths) return false;
		this.#pending.delete(toolCallId);
		for (const path of paths) if (this.#stamps.has(path)) this.#stamps.set(path, ++this.#seq);
		return true;
	}

	/** Settles every call still pending: a run ended, and a call stock refused before running it never reports back. */
	settleAll(): boolean {
		let any = false;
		for (const id of [...this.#pending.keys()]) any = this.settle(id) || any;
		return any;
	}

	/**
	 * Main saw these claims committed (`git status` no longer lists them): they stop being this session's. A file
	 * changed again since (its stamp moved on) stays: that later change is a fresh claim. A file a running call is
	 * still writing stays too.
	 */
	retire(claims: ReadonlyArray<{ file: string; stamp: number }>): void {
		const writing = new Set([...this.#pending.values()].flat());
		const gone = new Set(
			claims
				.filter(claim => !writing.has(claim.file) && this.#stamps.get(claim.file) === claim.stamp)
				.map(claim => claim.file),
		);
		if (gone.size === 0) return;
		this.#files = this.#files.filter(file => !gone.has(file));
		for (const file of gone) this.#stamps.delete(file);
	}
}

/** `checkout_retire`'s claims; anything malformed is skipped. */
export function retiredClaims(params: unknown): Array<{ file: string; stamp: number }> {
	const files = typeof params === "object" && params !== null && "files" in params ? params.files : undefined;
	if (!Array.isArray(files)) return [];
	return files.flatMap(item =>
		typeof item === "object" &&
		item !== null &&
		"file" in item &&
		"stamp" in item &&
		typeof item.file === "string" &&
		typeof item.stamp === "number"
			? [{ file: item.file, stamp: item.stamp }]
			: [],
	);
}
