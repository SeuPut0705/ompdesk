/** Pure parsers/projections for the GUI-side git commands (unit-tested). */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import * as path from "node:path";

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

export interface GitStatusSummary {
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
}

/** Branch + counts from `git status --porcelain=v2 --branch -z --untracked-files=all`. */
export function parseStatusV2(text: string): GitStatusSummary {
	const summary: GitStatusSummary = { branch: null, staged: 0, unstaged: 0, untracked: 0 };
	const records = text.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record.startsWith("# branch.head ")) {
			const head = record.slice("# branch.head ".length);
			summary.branch = head === "(detached)" ? null : head;
		} else if (record.startsWith("1 ") || record.startsWith("2 ")) {
			if (record[2] !== ".") summary.staged++;
			if (record[3] !== ".") summary.unstaged++;
			// Rename/copy records carry the original path as the next NUL field.
			if (record.startsWith("2 ")) i++;
		} else if (record.startsWith("u ")) {
			summary.unstaged++;
		} else if (record.startsWith("? ")) {
			summary.untracked++;
		}
	}
	return summary;
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

/** Binary when the header has a NUL byte or is not valid UTF-8 (truncated trailing sequence tolerated). */
export function isProbablyBinaryHeader(header: Uint8Array): boolean {
	if (header.indexOf(0) !== -1) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(header, { stream: true });
		return false;
	} catch {
		return true;
	}
}

/** Synthesize the all-added hunk for a new/untracked file. */
export function newFileDiff(content: string): string {
	if (!content) return "";
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}`;
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

/** 7-hex digest of a repository root, used to keep worktree dirs of different repos apart. */
export function hashPath(absPath: string): string {
	return createHash("sha256").update(path.resolve(absPath)).digest("hex").slice(0, 7);
}

/** `~/.omp/wt` (or `OMP_WORKTREE_DIR`), the directory omp's own worktree producers share. */
export function worktreesDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const override = env.OMP_WORKTREE_DIR?.trim();
	if (override) return path.resolve(override.startsWith("~") ? path.join(home, override.slice(1)) : override);
	return path.join(home, ".omp", "wt");
}

/** Candidate `{path, branch}` for GUI worktree attempt `suffix` (1 = bare name). */
export function guiWorktreeCandidate(
	slug: string,
	primaryRoot: string,
	suffix: number,
	baseDir: string = worktreesDir(),
): { name: string; branch: string; path: string } {
	const name = suffix === 1 ? slug : `${slug}-${suffix}`;
	return { name, branch: `omp/gui/${name}`, path: path.join(baseDir, `gui-${name}-${hashPath(primaryRoot)}`) };
}

export interface PrDiffFile {
	path: string;
	oldPath?: string;
	startOffset: number;
	endOffset: number;
}

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

export function rollupCounts(rollup: Array<{ status?: string; conclusion?: string | null }> | null | undefined): {
	success: number;
	failure: number;
	pending: number;
} {
	const counts = { success: 0, failure: 0, pending: 0 };
	for (const check of rollup ?? []) {
		if (check.conclusion === "SUCCESS" || check.conclusion === "NEUTRAL" || check.conclusion === "SKIPPED")
			counts.success += 1;
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
