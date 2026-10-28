import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Cover, findSymbolSpans, parseCover, parseHunks, rangeChanges, spanText } from "./covers";
import { run } from "./proc";

export interface DriftResult {
	/** `no-git`: git could not start, so drift was not checked (never a FAIL). */
	status: "ok" | "drift" | "unstamped" | "bad-commit" | "git-error" | "no-covers" | "no-git";
	/** What differs from the sync commit: files, `file#symbol` and `file:start-end` entries. */
	files: string[];
	message: string;
}

export interface GitResult {
	ok: boolean;
	/** git could not be started at all (not installed, not on PATH). */
	missing: boolean;
	/** Standard output only, trimmed: git writes warnings (an autocrlf "LF will be replaced by CRLF") to stderr. */
	out: string;
	/** The same standard output as git wrote it: file contents (`git show`) must not lose their first or last lines' whitespace. */
	raw: string;
	/** Standard error, or the reason git could not start. For messages, never for parsing. */
	err: string;
}

/** Runs git in the code root; `ok` is false when git is missing or exits non-zero. Output is stdout only. */
export async function git(codeRoot: string, args: string[]): Promise<GitResult> {
	const result = await run("git", args, { cwd: codeRoot, timeoutMs: 60_000 });
	return {
		ok: !result.spawnError && result.code === 0,
		missing: Boolean(result.spawnError),
		out: result.stdout.trim(),
		raw: result.stdout,
		err: (result.spawnError?.message ?? result.stderr).trim(),
	};
}

/** One line for a message about a failed git call. */
function failure(result: GitResult): string {
	return (result.err || result.out).split(/\r?\n/)[0] ?? "";
}

/** NUL-separated names (`-z`: no quoting of unusual names, no newline splitting). */
function names(result: GitResult): string[] {
	return result.out.split("\0").filter(Boolean);
}

/** The same text whatever the checkout's line endings: an autocrlf working copy is not a change. */
function lf(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

interface Material {
	/** The covers that differ from the base, named the way the manifest names them. */
	changed: string[];
	/** A text that is the same exactly when the covered code is the same: the digest of a dirty stamp is made from it. */
	text: string;
	/** Set when git or a cover could not be evaluated. */
	error?: string;
}

function read(file: string): string | null {
	try {
		return lf(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * `git diff` as this script needs it, whatever the user's configuration says: no external diff tool (`diff.external`,
 * difftastic prints no hunks), no textconv filter, no color, no rename pairing (a rename is a deletion and an
 * addition), a CR before the line break is not a change.
 */
const PLAIN_DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-cr-at-eol"];

/** The file as `base` had it, found from the code root (`./`: the code root can sit below the repository root); null when `base` has no such file. */
async function atBase(codeRoot: string, base: string, file: string): Promise<string | null> {
	const shown = await git(codeRoot, ["show", `${base}:./${file}`]);
	return shown.ok ? lf(shown.raw) : null;
}

/** Number of lines of a text, a final line break not counted. */
function lineCount(text: string): number {
	const count = text.split("\n").length;
	return text.endsWith("\n") ? count - 1 : count;
}

/** Every folder prefix of a path, and the path itself: `a/b/c.ts` gives `a`, `a/b`, `a/b/c.ts`. */
function ancestors(file: string): string[] {
	const parts = file.split("/");
	return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * An error text when a cover lies inside a git submodule (a gitlink, mode 160000, in the tree): the superproject
 * knows only the submodule's commit, so `git show` and `git diff` cannot compare the code in it. `ls-tree` on the
 * exact folder names shows the gitlink itself (`ls-files -s` on a folder lists everything below it).
 */
async function submoduleProblem(codeRoot: string, covers: Cover[], base: string): Promise<string | undefined> {
	const folders = [...new Set(covers.flatMap(cover => ancestors(cover.path)))];
	if (folders.length === 0) return undefined;
	const links = new Set<string>();
	for (const rev of new Set([base, "HEAD"])) {
		const listed = await git(codeRoot, ["ls-tree", "-z", rev, "--", ...folders]);
		if (!listed.ok) continue;
		for (const entry of listed.out.split("\0")) {
			const tab = entry.indexOf("\t");
			if (tab > 0 && entry.startsWith("160000 ")) links.add(entry.slice(tab + 1));
		}
	}
	for (const cover of covers) {
		const link = [...links].find(candidate => cover.path.startsWith(`${candidate}/`));
		if (link)
			return `${cover.raw}: ${cover.path} is inside the git submodule ${link}, whose history is its own: use the submodule as the code root ("codeRoot" in manifest.json) instead of a path through this repository`;
	}
	return undefined;
}

/** The covered code that differs between `base` (a commit) and the working tree. */
async function coverMaterial(codeRoot: string, covers: string[], base: string): Promise<Material> {
	const material: Material = { changed: [], text: "" };
	let parsed: Cover[];
	try {
		parsed = covers.map(parseCover);
	} catch (error) {
		return { ...material, error: error instanceof Error ? error.message : String(error) };
	}
	const short = base.slice(0, 10);
	const inSubmodule = await submoduleProblem(codeRoot, parsed, base);
	if (inSubmodule) return { ...material, error: inSubmodule };
	// A cover that points at nothing, now or then, would read "unchanged" for ever.
	for (const cover of parsed) {
		if (fs.existsSync(path.join(codeRoot, cover.path))) continue;
		if ((await git(codeRoot, ["cat-file", "-e", `${base}:./${cover.path}`])).ok) continue;
		return {
			...material,
			error: `${cover.raw}: no file or folder ${cover.path} now or at ${short}: fix the covers entry`,
		};
	}
	// Whole files and folders: one diff for all of them, plus new files nobody added yet (`git diff` does not see them).
	const wholes = parsed.filter(cover => cover.kind === "path");
	if (wholes.length > 0) {
		const changed = await git(codeRoot, [
			...PLAIN_DIFF,
			"--name-only",
			"-z",
			"--relative",
			base,
			"--",
			...wholes.map(cover => cover.path),
		]);
		if (!changed.ok) return { ...material, error: `git diff failed: ${failure(changed)}` };
		const added = await git(codeRoot, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
			"--",
			...wholes.map(cover => cover.path),
		]);
		const files = [...new Set([...names(changed), ...(added.ok ? names(added) : [])])].sort();
		for (const file of files) {
			// What the digest holds is the file's content, not `git diff` text (which varies with git's settings).
			const nowText = read(path.join(codeRoot, file));
			if (nowText !== null && nowText === (await atBase(codeRoot, base, file))) continue;
			material.changed.push(file);
			material.text += `file ${file}\n${nowText ?? "<deleted>"}\n`;
		}
	}
	for (const cover of parsed) {
		if (cover.kind === "path") continue;
		const now = read(path.join(codeRoot, cover.path));
		const was = await atBase(codeRoot, base, cover.path);
		if (now === null && was === null)
			return { ...material, error: `${cover.raw}: ${cover.path} is not a file: fix the covers entry` };
		if (cover.kind === "symbol") {
			const spansNow = now === null ? [] : findSymbolSpans(now, cover.symbol);
			const spansWas = was === null ? [] : findSymbolSpans(was, cover.symbol);
			if (spansNow.length === 0 && spansWas.length === 0) {
				return {
					...material,
					error: `${cover.raw}: no declaration named ${cover.symbol} in ${cover.path}, now or at ${short}: fix the covers entry`,
				};
			}
			const textNow = now === null ? "" : spanText(now, spansNow);
			const textWas = was === null ? "" : spanText(was, spansWas);
			if (textNow !== textWas) {
				material.changed.push(
					now === null
						? `${cover.raw} (file deleted)`
						: spansNow.length === 0
							? `${cover.raw} (gone or renamed)`
							: spansWas.length === 0
								? `${cover.raw} (new since the sync commit)`
								: cover.raw,
				);
				material.text += `symbol ${cover.raw}\n${textNow}\n`;
			}
			continue;
		}
		if (now === null) {
			material.changed.push(`${cover.raw} (file deleted)`);
			material.text += `range ${cover.raw} deleted\n`;
			continue;
		}
		const total = lineCount(now);
		if (cover.end > total) {
			return {
				...material,
				error: `${cover.raw}: the range ends at line ${cover.end}, past the end of ${cover.path} (${total} lines): fix the covers entry`,
			};
		}
		const lines = now.split("\n").slice(cover.start - 1, cover.end);
		if (was === null) {
			material.changed.push(`${cover.raw} (new since the sync commit)`);
			material.text += `range ${cover.raw} new\n${lines.join("\n")}\n`;
			continue;
		}
		const diff = await git(codeRoot, [...PLAIN_DIFF, "-U0", base, "--", cover.path]);
		if (!diff.ok) return { ...material, error: `git diff failed: ${failure(diff)}` };
		const { touched, shifted } = rangeChanges(parseHunks(diff.out), cover.start, cover.end);
		if (touched || shifted !== 0) {
			material.changed.push(
				shifted !== 0 && !touched
					? `${cover.raw} (lines moved by ${shifted > 0 ? "+" : ""}${shifted}: update the range)`
					: cover.raw,
			);
			material.text += `range ${cover.raw} shifted ${shifted}\n${lines.join("\n")}\n`;
		}
	}
	material.changed.sort();
	return material;
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Did the code a model covers change since the commit at which it was last confirmed? The working tree is compared
 * with the sync commit, so uncommitted edits count too. A model stamped on a dirty tree carries `syncDiff` (see
 * `stampDigest`): its covered code is in sync while it still equals what was stamped.
 */
export async function checkDrift(
	codeRoot: string,
	covers: string[],
	syncCommit: string | null,
	syncDiff?: string | null,
): Promise<DriftResult> {
	if (covers.length === 0) return { status: "no-covers", files: [], message: "no covered files listed" };
	if (!syncCommit) {
		return {
			status: "unstamped",
			files: [],
			message: "no syncCommit yet: the model was never confirmed against the code (use --stamp)",
		};
	}
	const known = await git(codeRoot, ["cat-file", "-e", `${syncCommit}^{commit}`]);
	if (known.missing)
		return {
			status: "no-git",
			files: [],
			message: `git could not start (${failure(known)}), so drift was not checked`,
		};
	if (!known.ok) {
		const shallow = await git(codeRoot, ["rev-parse", "--is-shallow-repository"]);
		return {
			status: "bad-commit",
			files: [],
			message:
				shallow.out === "true"
					? `syncCommit ${syncCommit} is not in this clone: shallow clone: fetch with depth 0 (git fetch --unshallow; in GitHub Actions actions/checkout with fetch-depth: 0)`
					: `syncCommit ${syncCommit} is not a commit of this repository (squashed or rewritten history? re-stamp the model on the current branch with verify-all.ts --stamp)`,
		};
	}
	const material = await coverMaterial(codeRoot, covers, syncCommit);
	if (material.error) return { status: "git-error", files: [], message: material.error };
	const short = syncCommit.slice(0, 10);
	if (syncDiff) {
		if (digest(material.text) === syncDiff)
			return {
				status: "ok",
				files: [],
				message: `covered code equals what was stamped on top of ${short} (stamped with uncommitted changes)`,
			};
		return {
			status: "drift",
			files: material.changed,
			message: `DRIFT: the covered code differs from what was stamped on top of ${short}; check the model still describes it, then re-stamp${
				covers.some(cover => parseCover(cover).kind === "path")
					? " (a stamp written before the digest was made from file contents lands here too: re-stamp it)"
					: ""
			}`,
		};
	}
	if (material.changed.length === 0)
		return { status: "ok", files: [], message: `covered code unchanged since ${short}` };
	return {
		status: "drift",
		files: material.changed,
		message: `DRIFT: ${material.changed.length} covered item(s) changed since ${short}; check the model still describes them, then re-stamp`,
	};
}

/** True when covered code (the covered functions and ranges, not the whole file) has uncommitted changes: a stamp of HEAD would not describe it. */
export async function hasUncommitted(codeRoot: string, covers: string[]): Promise<boolean> {
	if (covers.length === 0) return false;
	const material = await coverMaterial(codeRoot, covers, "HEAD");
	return material.changed.length > 0 || Boolean(material.error);
}

/** What stamping `head` would write for a model: whether its covered code has uncommitted changes, their digest, or why the covers cannot be stamped at all. */
export async function planStamp(
	codeRoot: string,
	covers: string[],
	head: string,
): Promise<{ dirty: boolean; digest: string; error?: string }> {
	const material = await coverMaterial(codeRoot, covers, head);
	return {
		dirty: material.changed.length > 0,
		digest: digest(material.text),
		...(material.error ? { error: material.error } : {}),
	};
}

/** The `syncDiff` of a model stamped on `head` while its covered code has uncommitted changes. */
export async function stampDigest(codeRoot: string, covers: string[], head: string): Promise<string> {
	return digest((await coverMaterial(codeRoot, covers, head)).text);
}
