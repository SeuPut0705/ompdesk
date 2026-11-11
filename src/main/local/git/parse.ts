/** Pure parsers/projections for the GUI-side git commands (unit-tested). */
import * as path from "node:path";
import { githubConclusionPassed } from "../../../shared/github-checks";
import { GUI_WORKTREE_BRANCH_PREFIX } from "../../../shared/worktree-branch";

export interface GitStatusEntry {
	path: string;
	oldPath?: string;
	index: string;
	worktree: string;
}

/** Parse `git status --porcelain=v1 -z` without splitting paths on whitespace. */
export function parseGitStatus(text: string): GitStatusEntry[] {
	const records = text.split("\0");
	const entries: GitStatusEntry[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record.length < 4) continue;
		const index = record[0] ?? " ";
		const worktree = record[1] ?? " ";
		const oldPath = index === "R" || index === "C" || worktree === "R" || worktree === "C" ? records[++i] : undefined;
		entries.push({ path: record.slice(3), oldPath, index, worktree });
	}
	return entries;
}

/** A branch or tag name git accepts (`git check-ref-format --branch` rules, checked without spawning git). */
export function isValidRefName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= 200 &&
		!name.startsWith("-") &&
		!name.startsWith("/") &&
		!name.endsWith("/") &&
		!name.endsWith(".") &&
		!name.endsWith(".lock") &&
		!name.includes("..") &&
		!name.includes("//") &&
		!name.includes("@{") &&
		name !== "@" &&
		!/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) &&
		!name.split("/").some(part => part.startsWith("."))
	);
}

/** Validate a repository-relative path from the renderer (no absolute, NUL, or `..` segment). */
export function isSafeRelativePath(filePath: string): boolean {
	return !(
		!filePath ||
		filePath.includes("\0") ||
		path.isAbsolute(filePath) ||
		path.win32.isAbsolute(filePath) ||
		filePath.split(/[\\/]/).includes("..")
	);
}

/** True when `child` is strictly inside `root` (both already real paths). */
export function isInside(root: string, child: string): boolean {
	const relative = path.relative(root, child);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Lowercase, spaces→`-`, strip everything outside [a-z0-9-], collapse runs, trim dashes. */
export function slugifyName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Slug for a GUI worktree name, or null when the raw name has disallowed characters. */
export function worktreeSlug(raw: string): string | null {
	const slug = slugifyName(raw);
	if (/[^a-z0-9 -]/i.test(raw) || !WORKTREE_NAME_PATTERN.test(slug)) return null;
	return slug;
}

/** Candidate `{path, branch}` for GUI worktree attempt `suffix` (1 = bare name); the folder name never takes the prefix. */
export function guiWorktreeCandidate(
	slug: string,
	repoHash: string,
	suffix: number,
	baseDir: string,
	branchPrefix = GUI_WORKTREE_BRANCH_PREFIX,
): { name: string; branch: string; path: string } {
	const name = suffix === 1 ? slug : `${slug}-${suffix}`;
	return { name, branch: `${branchPrefix}${name}`, path: path.join(baseDir, `gui-${name}-${repoHash}`) };
}

export interface PrDiffFile {
	path: string;
	oldPath?: string;
	startOffset: number;
	endOffset: number;
}

/** Kept over stock tools/gh-pr-diff: decode octal UTF-8 bytes together, so Korean filenames do not become mojibake. */
function parseQuoted(text: string, start: number): { value: string; next: number } | undefined {
	if (text.charAt(start) !== '"') return undefined;
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	for (let i = start + 1; i < text.length; i++) {
		const ch = text.charAt(i);
		if (ch === '"') return { value: new TextDecoder().decode(new Uint8Array(bytes)), next: i + 1 };
		if (ch !== "\\") {
			bytes.push(...encoder.encode(ch));
			continue;
		}
		const nextCh = text.charAt(i + 1);
		if (nextCh >= "0" && nextCh <= "7") {
			let end = i + 1;
			while (end < text.length && end < i + 4 && text.charAt(end) >= "0" && text.charAt(end) <= "7") end++;
			bytes.push(Number.parseInt(text.slice(i + 1, end), 8));
			i = end - 1;
			continue;
		}
		const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
		bytes.push(...encoder.encode(escapes[nextCh] ?? nextCh));
		i++;
	}
	return undefined;
}

/** Old/new paths from a `diff --git a/x b/y` header (quoted C-style paths supported). */
export function parseDiffHeaderPaths(header: string): { oldPath?: string; newPath?: string } {
	const trail = header.slice("diff --git ".length);
	const strip = (value: string, prefix: string) => (value.startsWith(prefix) ? value.slice(prefix.length) : undefined);
	if (trail.startsWith('"')) {
		const oldToken = parseQuoted(trail, 0);
		if (!oldToken) return {};
		let start = oldToken.next;
		while (trail.charAt(start) === " ") start++;
		const newToken = parseQuoted(trail, start) ?? { value: trail.slice(start), next: trail.length };
		return { oldPath: strip(oldToken.value, "a/"), newPath: strip(newToken.value, "b/") };
	}
	const bIdx = trail.indexOf(" b/");
	if (trail.startsWith("a/") && bIdx > 0) return { oldPath: trail.slice(2, bIdx), newPath: trail.slice(bIdx + 3) };
	return {};
}

/** Index a unified multi-file diff into per-file character ranges. */
export function parsePrUnifiedDiff(text: string): PrDiffFile[] {
	const starts: number[] = [];
	const re = /^diff --git /gm;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) starts.push(m.index);
	return starts.map((startOffset, i) => {
		const endOffset = starts[i + 1] ?? text.length;
		const lines = text.slice(startOffset, endOffset).split("\n");
		let { oldPath, newPath } = parseDiffHeaderPaths(lines[0] ?? "");
		let deleted = false;
		for (const line of lines.slice(1)) {
			if (line.startsWith("@@ ")) break;
			if (line.startsWith("deleted file mode")) deleted = true;
			else if (line.startsWith("rename from ")) oldPath = line.slice("rename from ".length);
			else if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length);
		}
		const display = deleted ? (oldPath ?? newPath ?? "(unknown)") : (newPath ?? oldPath ?? "(unknown)");
		return {
			path: display,
			...(oldPath && oldPath !== display ? { oldPath } : {}),
			startOffset,
			endOffset,
		};
	});
}

/** One entry of gh's `statusCheckRollup`: a check run (name, status, conclusion) or a commit status (context, state). */
export interface GhRollupEntry {
	name?: string;
	context?: string;
	status?: string;
	conclusion?: string | null;
	state?: string;
}

/**
 * The rollup as check runs. A commit status (Jenkins, Prow, a deploy hook) has only a `state`: SUCCESS, FAILURE
 * and ERROR are finished with that conclusion, PENDING and EXPECTED still wait.
 */
export function rollupChecks(
	rollup: readonly GhRollupEntry[] | null | undefined,
): { name: string; status: string; conclusion: string | null }[] {
	return (rollup ?? []).map(check => {
		const name = check.name ?? check.context ?? "check";
		if (check.status === undefined && check.state) {
			const finished = check.state === "SUCCESS" || check.state === "FAILURE" || check.state === "ERROR";
			return finished
				? { name, status: "COMPLETED", conclusion: check.state }
				: { name, status: check.state, conclusion: null };
		}
		return { name, status: check.status ?? "", conclusion: check.conclusion || null };
	});
}

export function rollupCounts(rollup: readonly GhRollupEntry[] | null | undefined): {
	success: number;
	failure: number;
	pending: number;
} {
	const counts = { success: 0, failure: 0, pending: 0 };
	for (const check of rollupChecks(rollup)) {
		if (check.conclusion && githubConclusionPassed(check.conclusion)) counts.success += 1;
		else if (check.conclusion) counts.failure += 1;
		else counts.pending += 1;
	}
	return counts;
}

/** Minimal `{{var}}` / `{{#if var}}…{{/if}}` renderer for the bundled pr-draft prompts. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
	return template
		.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key: string, body: string) => (vars[key] ? body : ""))
		.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

/** First balanced `{title, body}` JSON object in model output (tolerates fences/noise around it). */
export function extractDraftJson(output: string): { title: string; body: string } | null {
	for (let start = output.indexOf("{"); start !== -1; start = output.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		for (let i = start; i < output.length; i++) {
			const ch = output[i];
			if (inString) {
				if (ch === "\\") i++;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				try {
					const parsed: unknown = JSON.parse(output.slice(start, i + 1));
					if (
						typeof parsed === "object" &&
						parsed !== null &&
						"title" in parsed &&
						"body" in parsed &&
						typeof parsed.title === "string" &&
						typeof parsed.body === "string"
					)
						return { title: parsed.title, body: parsed.body };
				} catch {
					// Not JSON — try the next opening brace.
				}
				break;
			}
		}
	}
	return null;
}
