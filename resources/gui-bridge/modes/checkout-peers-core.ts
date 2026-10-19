/**
 * Rules for sessions that share a checkout (contracts: checkout-peers-contracts.ts): the prompt section that names the
 * other sessions and how to reach them, and the `tool_call` guard that refuses a git command which would take,
 * overwrite or hide another session's work. Pure; the bridge module (checkout-peers.ts) and the GUI's tests call it.
 *
 * The guard reads `bash` with Autopilot's own shell parser (`gitInvocations`) and judges each git run by one table
 * (`GIT_RULES`): a repository-wide step (stash, deleting or moving a branch) is refused while any other session works
 * in any worktree of the repository; a worktree step (switching or resetting the checkout, cleaning, bulk staging,
 * `commit -a`) while another session works in the same worktree; a step on named paths only when a path is broad
 * (`.`, a directory, a glob) or names a file another session changed. A session working alone is never judged.
 */
import { type GitInvocation, gitInvocations, isInside, normalizePath } from "./autopilot-guard-core";
import type { CheckoutPeer, CheckoutPeers } from "./checkout-peers-contracts";

/** What one git run does to shared state, before knowing who else works here. */
type Hazard =
	| { scope: "repo" | "worktree"; what: string; instead: string }
	| { scope: "paths"; paths: string[]; what: string; instead: string };

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
	const elsewhere = peer.worktree && peer.worktree !== toplevel ? ` in ${peer.worktree}` : "";
	return `- ${name}${id}${where}${elsewhere}${changed}`;
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
): string | undefined {
	const repoPeers = [...peers.worktree, ...peers.repo];
	if (repoPeers.length === 0) return undefined;
	for (const git of gitInvocations(command, cwd)) {
		const refusal = judge(git, peers, repoPeers, ownFiles);
		if (refusal) return refusal;
	}
	return undefined;
}

function judge(
	git: GitInvocation,
	peers: CheckoutPeers,
	repoPeers: CheckoutPeer[],
	ownFiles: readonly string[],
): string | undefined {
	const { toplevel } = peers;
	// A git run in another repository (cd elsewhere, -C) is none of these sessions' business; an unresolvable cd counts as here.
	if (!git.cwd.startsWith("\u0000") && !isInside(git.cwd, toplevel)) return undefined;
	const hazard = GIT_RULES[git.sub]?.(git.args);
	if (!hazard) return undefined;
	let endangered: CheckoutPeer[];
	if (hazard.scope === "paths") {
		const cwd = git.cwd.startsWith("\u0000") ? toplevel : git.cwd;
		endangered = peers.worktree.filter(peer => hazard.paths.some(path => endangers(path, cwd, toplevel, peer)));
	} else endangered = hazard.scope === "repo" ? repoPeers : peers.worktree;
	if (endangered.length === 0) return undefined;
	const command = `git ${[git.sub, ...git.args].join(" ")}`.slice(0, 120);
	const own = ownFiles.length
		? ` Files you changed: ${ownFiles
				.slice(0, 12)
				.map(file => relative(file, toplevel))
				.join(", ")}.`
		: "";
	return [
		`Refused while other sessions work here: \`${command}\`: ${hazard.what}.`,
		...endangered.map(peer => peerLine(peer, toplevel, hazard.scope !== "repo")),
		`${hazard.instead}${own}`,
		askLine(endangered, peers.canMessage),
	].join("\n");
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
			? "- Stage and commit only files you changed, by name (git add -- <file>, git commit -m <message> -- <file>): the index is shared, so a commit without paths takes what they staged. Never git add -A or ., commit -a, stash, reset, clean, switch, or checkout/restore of files you did not change: a guard refuses them while others work here. Run formatters and fixers on your own files only (prettier --write <file>), never on the whole tree."
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

/** `files` with `added` moved to the front, at most `max`. */
export function rememberFiles(files: readonly string[], added: readonly string[], max: number): string[] {
	const fresh = [...new Set(added)];
	return [...fresh, ...files.filter(file => !fresh.includes(file))].slice(0, max);
}
