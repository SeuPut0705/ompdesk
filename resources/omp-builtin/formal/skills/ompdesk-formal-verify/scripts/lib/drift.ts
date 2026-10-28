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

/** The covered code that differs between `base` (a commit) and the working tree. */
async function coverMaterial(codeRoot: string, covers: string[], base: string): Promise<Material> {
	const material: Material = { changed: [], text: "" };
	let parsed: Cover[];
	try {
		parsed = covers.map(parseCover);
	} catch (error) {
		return { ...material, error: error instanceof Error ? error.message : String(error) };
	}
	// Whole files and folders: one diff for all of them, plus new files nobody added yet (`git diff` does not see them).
	const wholes = parsed.filter(cover => cover.kind === "path");
	if (wholes.length > 0) {
		const changed = await git(codeRoot, [
			"diff",
			"--name-only",
			"-z",
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
			const body = await git(codeRoot, ["diff", base, "--", file]);
			material.changed.push(file);
			material.text += `file ${file}\n${lf(body.out) || read(path.join(codeRoot, file)) || ""}\n`;
		}
	}
	for (const cover of parsed) {
		if (cover.kind === "path") continue;
		const now = read(path.join(codeRoot, cover.path));
		if (cover.kind === "symbol") {
			const was = await git(codeRoot, ["show", `${base}:${cover.path}`]);
			const spansNow = now === null ? [] : findSymbolSpans(now, cover.symbol);
			const wasText = was.ok ? lf(was.out) : "";
			const spansWas = was.ok ? findSymbolSpans(wasText, cover.symbol) : [];
			if (spansNow.length === 0 && spansWas.length === 0) {
				return {
					...material,
					error: `${cover.raw}: no declaration named ${cover.symbol} in ${cover.path}, now or at ${base.slice(0, 10)}: fix the covers entry`,
				};
			}
			const textNow = now === null ? "" : spanText(now, spansNow);
			const textWas = was.ok ? spanText(wasText, spansWas) : "";
			if (textNow !== textWas) {
				material.changed.push(
					spansNow.length === 0
						? `${cover.raw} (gone or renamed)`
						: spansWas.length === 0
							? `${cover.raw} (new since the sync commit)`
							: cover.raw,
				);
				material.text += `symbol ${cover.raw}\n${textNow}\n`;
			}
		} else {
			const diff = await git(codeRoot, ["diff", "-U0", "--no-color", base, "--", cover.path]);
			if (!diff.ok) return { ...material, error: `git diff failed: ${failure(diff)}` };
			const { touched, shifted } = rangeChanges(parseHunks(diff.out), cover.start, cover.end);
			if (touched || shifted !== 0) {
				material.changed.push(
					shifted !== 0 && !touched
						? `${cover.raw} (lines moved by ${shifted > 0 ? "+" : ""}${shifted}: update the range)`
						: cover.raw,
				);
				const lines = (now ?? "").split(/\r?\n/).slice(cover.start - 1, cover.end);
				material.text += `range ${cover.raw} shifted ${shifted}\n${lines.join("\n")}\n`;
			}
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
	if (!known.ok)
		return {
			status: "bad-commit",
			files: [],
			message: `syncCommit ${syncCommit} is not a commit of this repository`,
		};
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
			message: `DRIFT: the covered code differs from what was stamped on top of ${short}; check the model still describes it, then re-stamp`,
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

/** The `syncDiff` of a model stamped on `head` while its covered code has uncommitted changes. */
export async function stampDigest(codeRoot: string, covers: string[], head: string): Promise<string> {
	return digest((await coverMaterial(codeRoot, covers, head)).text);
}
