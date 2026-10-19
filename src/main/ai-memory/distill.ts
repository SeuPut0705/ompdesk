/**
 * Turning a stretch of a person's conversation into the few durable pages worth keeping (decisions, rules, gotchas,
 * procedures). ai-memory's own consolidation needs an LLM provider configured on the server, and OMPdesk keeps the
 * server provider-less (no key ever leaves omp's own credential store), so the model runs where the user's models
 * already do: a one-shot `omp -p` on the cheap (`smol`) role, no tools, no session, no extensions, and the app writes
 * what comes back through the server's write path after checking it.
 *
 * The pure parts live here (what is read, what is asked, what is accepted); the schedule and the I/O are `distill-job.ts`.
 */
import type { AiMemoryObservation } from "../../shared/ai-memory";
import { isAgentPrompt, unwrapPrompt } from "../../shared/memory-prompt";

/** A window needs this many new prompts a person typed before it is worth a model call. */
export const DISTILL_MIN_PROMPTS = 6;
/** One prompt is read up to this long (a person's prompt is a sentence or two; a pasted log is not knowledge). */
const PROMPT_CHARS = 700;
/** A window reads at most this many prompts (the newest are kept: the earlier ones were a previous window's). */
const WINDOW_PROMPTS = 40;
const TASK_TITLES = 12;
const EXISTING_TITLES = 40;
/** Pages one window may add: most windows add none. */
export const DISTILL_MAX_PAGES = 3;
const MIN_CONFIDENCE = 0.75;
/** Korean says a rule in 40 characters; fewer than that is a heading, not a page. */
const BODY_MIN = 40;
const BODY_MAX = 1800;
const TITLE_MAX = 80;

export type DistillKind = "decision" | "rule" | "gotcha" | "procedure";

/** Where a kind's pages live and how the server files them (`ai-memory-durable-pages`: the page layout it documents). */
export const KIND_LAYOUT: Record<DistillKind, { folder: string; tier: "semantic" | "procedural"; kind: string }> = {
	decision: { folder: "decisions", tier: "semantic", kind: "decision" },
	rule: { folder: "_rules", tier: "semantic", kind: "rule" },
	gotcha: { folder: "gotchas", tier: "semantic", kind: "gotcha" },
	procedure: { folder: "procedures", tier: "procedural", kind: "fact" },
};

export interface Proposal {
	kind: DistillKind;
	title: string;
	body: string;
	confidence: number;
	/** The numbers of the prompts (as the digest numbers them) the page rests on. */
	evidence: number[];
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
	return { text, shown: window.map(prompt => prompt.n) };
}

const SYSTEM = `You curate a project's long-term memory from what its owner said while working with an AI coding assistant.
You read a numbered excerpt of the owner's own messages and may write at most ${DISTILL_MAX_PAGES} memory pages. Most excerpts deserve none: answer {"pages":[]} unless something clearly lasts.

Write a page only for knowledge a future session needs and cannot get from the code:
- decision: a choice the owner made about how the product should work or be built, with the reason when they gave one, and what they rejected.
- rule: a standing preference or convention they want followed from now on ("always…", "never…", "stop doing…").
- gotcha: a failure, surprise or trap they ran into, and what it taught.
- procedure: a repeatable way of doing something they asked for.

Never write: progress or status of one task, questions the owner asked, anything the owner did not actually say, guesses about why, restatements of what the code already shows, or secrets. Do not record a question as a decision. If the owner only asked or doubted, there is no decision yet.
Cite the message numbers a page rests on. Give a confidence from 0 to 1 for how clearly the excerpt establishes it; write nothing below 0.75.
Write each page in the language the owner wrote in. A title is a specific noun phrase of at most ${TITLE_MAX} characters that tells the page apart from every title already in the project; a body is 2 to 8 short lines of plain markdown: the fact first, then the reason or the consequence.

Answer with one JSON object and nothing else:
{"pages":[{"kind":"decision|rule|gotcha|procedure","title":"...","body":"...","confidence":0.0,"evidence":[1,2]}]}`;

export interface DistillMessage {
	system: string;
	user: string;
}

/** The one request: the instructions, the digest and the titles the project already has (so a page is never written twice). */
export function distillMessage(digest: Digest, existingTitles: readonly string[]): DistillMessage {
	const known = existingTitles.slice(0, EXISTING_TITLES).map(title => `- ${title}`);
	return {
		system: SYSTEM,
		user: [
			digest.text,
			"",
			"## Pages the project already has (do not repeat them)",
			...(known.length ? known : ["(none)"]),
		].join("\n"),
	};
}

const KINDS = new Set<string>(Object.keys(KIND_LAYOUT));

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

/** The proposals a model's answer holds that pass the checks: a known kind, a real title and body, cited prompts, confidence. */
export function parseProposals(answer: string, shown: readonly number[], existingTitles: readonly string[]): Parsed {
	const parsed: Parsed = { proposals: [], refused: [] };
	const root = jsonObject(answer);
	const pages = root && typeof root === "object" && "pages" in root && Array.isArray(root.pages) ? root.pages : null;
	if (!pages) {
		parsed.refused.push("answer is not a {pages:[…]} object");
		return parsed;
	}
	const taken = new Set(existingTitles.map(title => title.toLowerCase().replaceAll(/\s+/g, " ").trim()));
	for (const entry of pages.slice(0, DISTILL_MAX_PAGES)) {
		const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
		const kind = typeof item.kind === "string" ? item.kind : "";
		const title = typeof item.title === "string" ? item.title.replaceAll(/\s+/g, " ").trim() : "";
		const body = typeof item.body === "string" ? item.body.trim() : "";
		const confidence = typeof item.confidence === "number" ? item.confidence : 0;
		const evidence = Array.isArray(item.evidence)
			? item.evidence.filter((value): value is number => Number.isInteger(value) && shown.includes(value as number))
			: [];
		const label = title || kind || "page";
		if (!KINDS.has(kind)) parsed.refused.push(`${label}: unknown kind`);
		else if (!title || title.length > TITLE_MAX)
			parsed.refused.push(`${label}: title missing or longer than ${TITLE_MAX}`);
		else if (body.length < BODY_MIN || body.length > BODY_MAX)
			parsed.refused.push(`${label}: body ${body.length} chars`);
		else if (confidence < MIN_CONFIDENCE) parsed.refused.push(`${label}: confidence ${confidence}`);
		else if (evidence.length === 0) parsed.refused.push(`${label}: cites no prompt it was shown`);
		else if (taken.has(title.toLowerCase().replaceAll(/\s+/g, " ")))
			parsed.refused.push(`${label}: title already used`);
		else {
			taken.add(title.toLowerCase().replaceAll(/\s+/g, " "));
			parsed.proposals.push({ kind: kind as DistillKind, title, body, confidence, evidence });
		}
	}
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

/** The page: the title as its H1 (the server derives the title from it), the body, and where it came from. */
export function proposalMarkdown(proposal: Proposal, sessionId: string): string {
	const cited = proposal.evidence.map(n => `#${n}`).join(", ");
	return [
		`# ${proposal.title}`,
		"",
		proposal.body,
		"",
		`_Source: the owner's messages ${cited}, session \`${sessionId}\` (memory upkeep)._`,
		"",
	].join("\n");
}
