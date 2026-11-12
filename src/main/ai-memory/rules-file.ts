/**
 * The project's rules file (AGENTS.md, CLAUDE.md at the repository root, `.omp/rules/*.md`): which of its words a page
 * shares, and what it outlines. The upkeep's use of it (the check that a learned page only repeats the file) moved into
 * the core with the learning (`native/ompdesk/crates/core/src/upkeep/rules_file.rs`).
 *
 * Kept for curate.ts until 7d moves it (this batch): `contentTerms`, `readRulesText`, `rulesOutline`.
 */
import { open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const RULES_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** omp's project rules folder: a repository can keep its rules there instead of one large AGENTS.md (this one does). */
const RULES_DIR = ".omp/rules";
const RULES_FILE_BYTES = 4 * 1024 * 1024;
/** The rules-file outline the distill prompt carries (≈ 1.5k tokens at most). */
const RULES_OUTLINE_BYTES = 6 * 1024;
/** A bold lead longer than this is an emphasized sentence, not a label. */
const OUTLINE_LEAD_CHARS = 100;

/** Words that say nothing about what a rule is about. */
const STOP_WORDS = new Set(
	(
		"the and for with that this from into are was were has have had not but its it's any all can will would should " +
		"must when then than them they their there here what which who how why use uses used using also only just more " +
		"most very one two each every other our your you via per out off own same such does did done been being onto"
	).split(" "),
);

const CJK_RUN = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

function stem(word: string): string {
	for (const ending of ["ing", "ed", "es", "s"]) {
		if (word.length > ending.length + 3 && word.endsWith(ending)) return word.slice(0, -ending.length);
	}
	return word;
}

// kept for curate.ts until 7d moves it (this batch)
/** A text's content terms. */
export function contentTerms(text: string): Set<string> {
	const terms = new Set<string>();
	const lower = text.normalize("NFKC").toLowerCase();
	for (const word of lower.match(/[a-z][a-z0-9_]{2,}/g) ?? []) {
		if (!STOP_WORDS.has(word)) terms.add(stem(word));
	}
	for (const run of lower.match(CJK_RUN) ?? []) {
		for (let index = 0; index + 1 < run.length; index++) terms.add(run.slice(index, index + 2));
	}
	return terms;
}

// kept for curate.ts until 7d moves it (this batch)
/**
 * What the distill prompt shows of the rules file so the model can see what is already a rule: its `#`, `##` and `###`
 * headings and the bold phrase a line opens with (`- **No count or rate caps**: …` → `- No count or rate caps`; one
 * over `OUTLINE_LEAD_CHARS` is an emphasized sentence, not a label, and is left out), shown in the file's order, whole
 * lines up to `RULES_OUTLINE_BYTES`. The headings are taken first and the leads after them, so the bound drops leads
 * late in the file rather than whole later sections (OMPdesk's AGENTS.md: headings 4 KB, leads far more). The lexical
 * `statedByRules` cannot match a Korean page to an English file (replay of 19 Oct 2026: 0 of 15 pages skipped, at
 * least 4 stated in AGENTS.md); the model can.
 */
export function rulesOutline(text: string): string {
	const headings: { at: number; line: string }[] = [];
	const leads: { at: number; line: string }[] = [];
	text.split("\n").forEach((line, at) => {
		if (/^#{1,3} \S/.test(line)) headings.push({ at, line: line.trimEnd() });
		else {
			const lead = /^\s*(?:[-*]\s+)?\*\*([^*\n]+?)\*\*/.exec(line)?.[1]?.trim();
			if (lead && lead.length <= OUTLINE_LEAD_CHARS) leads.push({ at, line: `- ${lead}` });
		}
	});
	const kept: { at: number; line: string }[] = [];
	let bytes = 0;
	for (const entry of [...headings, ...leads]) {
		const size = Buffer.byteLength(entry.line) + 1;
		if (bytes + size > RULES_OUTLINE_BYTES + 1) break;
		kept.push(entry);
		bytes += size;
	}
	return kept
		.sort((a, b) => a.at - b.at)
		.map(entry => entry.line)
		.join("\n");
}

/** The repository root holding `cwd` (a `.git` folder or file), else `cwd` itself. */
async function repositoryRoot(cwd: string): Promise<string> {
	for (let dir = cwd; ; ) {
		if (
			await stat(join(dir, ".git")).then(
				() => true,
				() => false,
			)
		)
			return dir;
		const up = dirname(dir);
		if (up === dir) return cwd;
		dir = up;
	}
}

async function head(file: string): Promise<string> {
	const handle = await open(file, "r").catch(() => null);
	if (!handle) return "";
	try {
		const length = Math.min((await handle.stat()).size, RULES_FILE_BYTES);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch {
		return "";
	} finally {
		await handle.close();
	}
}

// kept for curate.ts until 7d moves it (this batch)
/**
 * The rules files at the root of the repository `cwd` is in, then each `.omp/rules/*.md` in name order, joined (each
 * read whole up to `RULES_FILE_BYTES`); empty when there are none (or no `cwd`).
 */
export async function readRulesText(cwd: string): Promise<string> {
	if (!cwd) return "";
	const root = await repositoryRoot(cwd);
	const ruleFiles = (await readdir(join(root, RULES_DIR)).catch(() => [] as string[]))
		.filter(name => name.endsWith(".md"))
		.sort()
		.map(name => join(RULES_DIR, name));
	return (await Promise.all([...RULES_FILES, ...ruleFiles].map(name => head(join(root, name)))))
		.filter(Boolean)
		.join("\n");
}
