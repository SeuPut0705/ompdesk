/**
 * Turning a stretch of a person's conversation into the few durable pages worth keeping (decisions, rules, gotchas,
 * procedures, and the owner's preferences and corrections, which hold in every project). ai-memory's own
 * consolidation needs an LLM provider configured on the server, and OMPdesk keeps the server provider-less (no key ever
 * leaves omp's own credential store), so the model runs where the user's models already do: a one-shot `omp -p` on the
 * cheap (`smol`) role, no tools, no session, no extensions, and the app writes what comes back through the server's
 * write path after checking it.
 *
 * The pure parts live here (what is read, what is asked, what is accepted); the schedule and the I/O are `upkeep.ts`.
 */

import { isAgentPrompt, unwrapPrompt } from "../../../resources/gui-bridge/memory-prompt";
import type { AiMemoryObservation } from "../../shared/ai-memory";

/** A window needs this many new prompts a person typed before it is worth a model call. */
export const DISTILL_MIN_PROMPTS = 6;
/** One prompt is read up to this long (a person's prompt is a sentence or two; a pasted log is not knowledge). */
const PROMPT_CHARS = 700;
/** A window reads at most this many prompts (the newest are kept: the earlier ones were a previous window's). */
const WINDOW_PROMPTS = 40;
const TASK_TITLES = 12;
/** The project's own durable pages the model is shown, newest first. */
export const KNOWN_PROJECT_PAGES = 30;
/** The owner's preferences (kept in `_global`, read in every project) the model is shown beside them. */
export const KNOWN_GLOBAL_PAGES = 20;
/** Pages one window may add: most windows add none. */
export const DISTILL_MAX_PAGES = 3;
const MIN_CONFIDENCE = 0.75;
/**
 * A correction weighs more than anything else a window yields: the owner had to stop and redo the assistant's work, so
 * the lesson is established by the friction itself (the evidence rule of omp's `sharpshooter`). It needs less
 * confidence and is kept first when an answer holds more pages than one window may add.
 */
const CORRECTION_MIN_CONFIDENCE = 0.65;
/** Korean says a rule in 40 characters; fewer than that is a heading, not a page. */
const BODY_MIN = 40;
const BODY_MAX = 1800;
const TITLE_MAX = 80;
/** A quote shorter than this proves nothing ("응", "ok"). */
const QUOTE_MIN = 4;
const QUOTE_MAX = 300;
const GIST_MAX = 300;

export type DistillKind = "decision" | "rule" | "gotcha" | "procedure" | "preference" | "correction";

/** `_global`: the reserved project ai-memory's `memory_query` unions into every project's default recall. */
export const GLOBAL_PROJECT = { workspace: "default", project: "_global" } as const;

/**
 * Where a kind's pages live and how the server files them (`ai-memory-durable-pages`: the page layout it documents).
 * `global` pages are the owner's, not the project's: they go to `_global`. A correction is filed as a preference (the
 * server ranks `preference` pages up; a correction is the preference the owner had to state twice).
 */
export const KIND_LAYOUT: Record<
	DistillKind,
	{ folder: string; tier: "semantic" | "procedural"; kind: string; global: boolean }
> = {
	decision: { folder: "decisions", tier: "semantic", kind: "decision", global: false },
	rule: { folder: "_rules", tier: "semantic", kind: "rule", global: false },
	gotcha: { folder: "gotchas", tier: "semantic", kind: "gotcha", global: false },
	procedure: { folder: "procedures", tier: "procedural", kind: "fact", global: false },
	preference: { folder: "preferences", tier: "semantic", kind: "preference", global: true },
	correction: { folder: "preferences", tier: "semantic", kind: "preference", global: true },
};

export interface Proposal {
	kind: DistillKind;
	title: string;
	body: string;
	confidence: number;
	/** The numbers of the prompts (as the digest numbers them) the page rests on. */
	evidence: number[];
	/** The owner's own words the page rests on, copied verbatim from one of their prompts (whitespace aside). */
	quote?: string;
	/** The page's point as one English sentence: what is compared with the project's (English) rules file. */
	gist?: string;
}

/** A durable page memory already holds, as the model is shown it. */
export interface KnownPage {
	path: string;
	title: string;
	/** The start of its body, flattened, when it was read. */
	excerpt?: string;
	/** Kept in `_global` (the owner's preferences), not in the project. */
	global: boolean;
}

export interface DigestPrompt {
	/** Position among the session's person prompts (1-based): what a proposal's `evidence` cites. */
	n: number;
	text: string;
	/** When it was typed (ms since the epoch), when the server said. */
	at: number | null;
}

/** The prompts a person typed (an agent-written message is not their word), in capture order. */
export function personPrompts(observations: readonly AiMemoryObservation[]): DigestPrompt[] {
	const prompts: DigestPrompt[] = [];
	for (const observation of observations) {
		if (observation.kind !== "user-prompt") continue;
		const text = observation.body.trim();
		if (!text || isAgentPrompt(text)) continue;
		prompts.push({
			n: prompts.length + 1,
			text,
			at: observation.createdAt ? Date.parse(observation.createdAt) : null,
		});
	}
	return prompts;
}

function clip(text: string): string {
	const flat = text.replaceAll(/\s+/g, " ").trim();
	return flat.length > PROMPT_CHARS ? `${flat.slice(0, PROMPT_CHARS)}…` : flat;
}

export interface Digest {
	text: string;
	/** The prompt numbers the digest shows (what a proposal may cite). */
	shown: number[];
	/** The prompts it shows, whole: what a proposal's quote must come from. */
	prompts: DigestPrompt[];
}

/** What the model reads: the window's prompts, numbered, and the titles of the tasks delegated meanwhile. */
export function buildDigest(prompts: readonly DigestPrompt[], tasks: readonly string[]): Digest {
	const window = prompts.slice(-WINDOW_PROMPTS);
	const lines = window.map(prompt => `[${prompt.n}] ${clip(prompt.text)}`);
	const work = tasks.slice(0, TASK_TITLES).map(title => `- ${clip(unwrapPrompt(title).body || title)}`);
	const text = [
		"## What the person said (their own words, in order)",
		...lines,
		...(work.length ? ["", "## Work their assistant started meanwhile (task titles)", ...work] : []),
	].join("\n");
	return { text, shown: window.map(prompt => prompt.n), prompts: [...window] };
}

const SYSTEM = `You curate long-term memory from what its owner said while working with an AI coding assistant.
You read a numbered excerpt of the owner's own messages and may write at most ${DISTILL_MAX_PAGES} memory pages. Most excerpts deserve none: answer {"pages":[]} unless something clearly lasts.

Write a page only for knowledge a future session needs and cannot get from the code:
- decision: a choice the owner made about how this product should work or be built, with the reason when they gave one, and what they rejected.
- rule: a standing convention for this project ("always…", "never…", "stop doing…").
- gotcha: a failure, surprise or trap they ran into, and what it taught.
- procedure: a repeatable way of doing something they asked for.
- preference: how the owner wants any assistant to work in any project (scope, process, style, wording, how to report). It is kept for every project, so leave out anything that only makes sense in this codebase.
- correction: the owner told the assistant to redo or fix what it had just done. Record the lasting lesson (what to do instead, in every project), not the incident.

Never write: progress or status of one task, questions the owner asked, anything the owner did not actually say, guesses about why, restatements of what the code already shows, or secrets. Do not record a question as a decision. If the owner only asked or doubted, there is no decision yet.
Cite the message numbers a page rests on, and quote the owner: "quote" is a short passage copied character for character from one of those messages, in their language, with no translation, paraphrase or ellipsis. A preference or correction without such a quote is not written.
Give a confidence from 0 to 1 for how clearly the excerpt establishes it; write nothing below 0.75 (a correction: below 0.65).
Write each page in the language the owner wrote in. A title is a specific noun phrase of at most ${TITLE_MAX} characters that tells the page apart from every page memory already holds; a body is 2 to 8 short lines of plain markdown: the fact first, then the reason or the consequence. "gist_en" is the page's point as one plain English sentence.
Memory already holds the pages listed below. Do not repeat one.

Answer with one JSON object and nothing else:
{"pages":[{"kind":"decision|rule|gotcha|procedure|preference|correction","title":"...","body":"...","quote":"...","gist_en":"...","confidence":0.0,"evidence":[1,2]}]}`;

export interface DistillMessage {
	system: string;
	user: string;
}

/** The one request: the instructions, the digest and the pages memory already holds (so a page is never written twice). */
export function distillMessage(digest: Digest, known: readonly KnownPage[]): DistillMessage {
	const line = (page: KnownPage) => `- ${page.path} · ${page.title}${page.excerpt ? ` · ${page.excerpt}` : ""}`;
	const project = known
		.filter(page => !page.global)
		.slice(0, KNOWN_PROJECT_PAGES)
		.map(line);
	const global = known
		.filter(page => page.global)
		.slice(0, KNOWN_GLOBAL_PAGES)
		.map(line);
	return {
		system: SYSTEM,
		user: [
			digest.text,
			"",
			"## Pages the project already has",
			...(project.length ? project : ["(none)"]),
			"",
			"## The owner's preferences, kept for every project",
			...(global.length ? global : ["(none)"]),
		].join("\n"),
	};
}

/** The first balanced `{…}` of a model's answer (it may wrap the JSON in a fence or a sentence). */
function jsonObject(text: string): unknown {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (char === "\\") index += 1;
			else if (char === '"') inString = false;
		} else if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}" && --depth === 0) {
			try {
				return JSON.parse(text.slice(start, index + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}

export interface Parsed {
	proposals: Proposal[];
	/** Why proposals were refused, one line each (the log's evidence that the checks run). */
	refused: string[];
}

const flat = (text: string): string => text.replaceAll(/\s+/g, " ").trim();
const titleKey = (title: string): string => flat(title).toLowerCase();

/**
 * The proposals a model's answer holds that pass the checks: a known kind, a real title and body, cited prompts,
 * confidence, and a quote that is the owner's own words (required for a preference or correction, checked on any page
 * that gives one).
 */
export function parseProposals(answer: string, digest: Pick<Digest, "prompts">, known: readonly KnownPage[]): Parsed {
	const parsed: Parsed = { proposals: [], refused: [] };
	const root = jsonObject(answer);
	const pages = root && typeof root === "object" && "pages" in root && Array.isArray(root.pages) ? root.pages : null;
	if (!pages) {
		parsed.refused.push("answer is not a {pages:[…]} object");
		return parsed;
	}
	const shown = digest.prompts.map(prompt => prompt.n);
	const said = digest.prompts.map(prompt => ({ n: prompt.n, text: flat(prompt.text) }));
	const taken = new Set(known.map(page => titleKey(page.title)));
	const accepted: Proposal[] = [];
	// Read past the page limit so a correction late in the answer is weighed before the limit cuts.
	for (const entry of pages.slice(0, DISTILL_MAX_PAGES * 2)) {
		const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
		const kind = typeof item.kind === "string" ? item.kind : "";
		const title = typeof item.title === "string" ? flat(item.title) : "";
		const body = typeof item.body === "string" ? item.body.trim() : "";
		const confidence = typeof item.confidence === "number" ? item.confidence : 0;
		const evidence = Array.isArray(item.evidence)
			? item.evidence.filter((value): value is number => Number.isInteger(value) && shown.includes(value as number))
			: [];
		const quote = typeof item.quote === "string" ? flat(item.quote) : "";
		const quoted =
			quote.length >= QUOTE_MIN && quote.length <= QUOTE_MAX ? said.find(p => p.text.includes(quote)) : undefined;
		const label = title || kind || "page";
		const layout = KIND_LAYOUT[kind as DistillKind] as (typeof KIND_LAYOUT)[DistillKind] | undefined;
		if (!layout) parsed.refused.push(`${label}: unknown kind`);
		else if (!title || title.length > TITLE_MAX)
			parsed.refused.push(`${label}: title missing or longer than ${TITLE_MAX}`);
		else if (body.length < BODY_MIN || body.length > BODY_MAX)
			parsed.refused.push(`${label}: body ${body.length} chars`);
		else if (confidence < (kind === "correction" ? CORRECTION_MIN_CONFIDENCE : MIN_CONFIDENCE))
			parsed.refused.push(`${label}: confidence ${confidence}`);
		else if (evidence.length === 0 && !quoted) parsed.refused.push(`${label}: cites no prompt it was shown`);
		else if (quote && !quoted) parsed.refused.push(`${label}: quote is not the owner's words`);
		else if (!quote && layout.global) parsed.refused.push(`${label}: quotes no evidence`);
		else if (taken.has(titleKey(title))) parsed.refused.push(`${label}: title already used`);
		else {
			taken.add(titleKey(title));
			const gist = typeof item.gist_en === "string" ? flat(item.gist_en) : "";
			accepted.push({
				kind: kind as DistillKind,
				title,
				body,
				confidence,
				evidence: quoted && !evidence.includes(quoted.n) ? [...evidence, quoted.n].sort((a, b) => a - b) : evidence,
				...(quoted ? { quote } : {}),
				...(gist && gist.length <= GIST_MAX ? { gist } : {}),
			});
		}
	}
	// Stable: corrections first, the rest in the model's order.
	accepted.sort((a, b) => Number(b.kind === "correction") - Number(a.kind === "correction"));
	parsed.proposals = accepted.slice(0, DISTILL_MAX_PAGES);
	for (const dropped of accepted.slice(DISTILL_MAX_PAGES))
		parsed.refused.push(`${dropped.title}: over the ${DISTILL_MAX_PAGES}-page limit`);
	return parsed;
}

/** `decisions/<slug>.md`: letters and digits of any script, the rest folded to `-`, cut to a readable length. */
export function proposalPath(proposal: Pick<Proposal, "kind" | "title">): string {
	const slug = proposal.title
		.normalize("NFKC")
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, "-")
		.replaceAll(/^-+|-+$/g, "")
		.slice(0, 48)
		.replaceAll(/-+$/g, "");
	return `${KIND_LAYOUT[proposal.kind].folder}/${slug || "page"}.md`;
}

/** The page: the title as its H1 (the server derives the title from it), the body, the owner's words, and where it came from. */
export function proposalMarkdown(proposal: Proposal, sessionId: string): string {
	const cited = proposal.evidence.map(n => `#${n}`).join(", ");
	return [
		`# ${proposal.title}`,
		"",
		proposal.body,
		"",
		...(proposal.quote ? [`> ${proposal.quote}`, ""] : []),
		`_Source: the owner's messages ${cited}, session \`${sessionId}\` (memory upkeep)._`,
		"",
	].join("\n");
}
