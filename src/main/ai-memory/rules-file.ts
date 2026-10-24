/**
 * The project's rules file (AGENTS.md, CLAUDE.md at the repository root) is already in front of every session, so a
 * learned page that only repeats it is noise: on the user's own memory 4 of the 5 pages learned were in AGENTS.md.
 *
 * The check is local and cheap, no model call: a proposal is the rules file's when one sentence of the file holds at
 * least `RULES_COVERAGE` (0.6) of the proposal's content terms, weighted by how rare each term is in the file (IDF over
 * its sentences, so "session" or "user" count for little in OMPdesk's AGENTS.md and a term the file never uses counts
 * the most), and at least `RULES_MIN_SHARED` (3) of them. Terms are Latin words (lowercased, common words left out, a
 * plural or tense ending cut) and character pairs of Hangul, Han and kana runs. The owner usually writes in Korean and
 * the rules file in English, so the proposal's English gist (`gist_en`, written by the same model call) is compared
 * too; its title and body together are the other candidate. It cannot tell a rule from its negation ("keep only en-US"
 * and "keep every locale" share their terms), so a correction that contradicts the rules file is skipped as stated.
 * Read-only: the file is never written, and it is read whole up to `RULES_FILE_BYTES` (4 MB: OMPdesk's own AGENTS.md is
 * over 400 KB, and a cut at 200 KB missed half its rules).
 */
import { open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const RULES_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** omp's project rules folder: a repository can keep its rules there instead of one large AGENTS.md (this one does). */
export const RULES_DIR = ".omp/rules";
export const RULES_FILE_BYTES = 4 * 1024 * 1024;
export const RULES_COVERAGE = 0.6;
export const RULES_MIN_SHARED = 3;
/** The rules-file outline the distill prompt carries (≈ 1.5k tokens at most). */
export const RULES_OUTLINE_BYTES = 6 * 1024;
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

export interface RulesIndex {
	/** Each sentence's terms. */
	units: Set<string>[];
	/** How many sentences hold each term. */
	df: Map<string, number>;
}

/** The rules text as sentences' terms, the units a proposal is compared with one by one. */
export function rulesIndex(text: string): RulesIndex {
	const units = text
		.split(/\n|(?<=[.!?;。])\s+/)
		.map(contentTerms)
		.filter(terms => terms.size >= RULES_MIN_SHARED);
	const df = new Map<string, number>();
	for (const unit of units) for (const term of unit) df.set(term, (df.get(term) ?? 0) + 1);
	return { units, df };
}

function covered(terms: Set<string>, index: RulesIndex): boolean {
	if (terms.size < RULES_MIN_SHARED) return false;
	const weight = new Map(
		[...terms].map(term => [term, Math.log((index.units.length + 1) / ((index.df.get(term) ?? 0) + 1)) + 1]),
	);
	let total = 0;
	for (const value of weight.values()) total += value;
	for (const unit of index.units) {
		let shared = 0;
		let held = 0;
		for (const [term, value] of weight) {
			if (!unit.has(term)) continue;
			shared += 1;
			held += value;
		}
		if (shared >= RULES_MIN_SHARED && held / total >= RULES_COVERAGE) return true;
	}
	return false;
}

/** Whether the rules file already states what the proposal says. */
export function statedByRules(index: RulesIndex, proposal: { title: string; body: string; gist?: string }): boolean {
	if (index.units.length === 0) return false;
	return (
		(proposal.gist ? covered(contentTerms(proposal.gist), index) : false) ||
		covered(contentTerms(`${proposal.title}\n${proposal.body}`), index)
	);
}

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
