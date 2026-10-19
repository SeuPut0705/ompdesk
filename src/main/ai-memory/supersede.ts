/**
 * Which page memory already holds a new learned page replaces (Graphiti's rule: a newer fact invalidates the old one
 * instead of overwriting it). The model names it (`supersedes`, a path it was shown in the page's own scope); when it
 * names none, a page of the same kind in the same scope whose title is close enough is taken to be the same subject:
 * character-trigram Jaccard similarity of the titles ≥ `SUPERSEDE_TITLE_SIMILARITY` (0.6). An exact title is never
 * here: `parseProposals` refuses a title memory already has. A pinned page is the owner's and is never replaced.
 */
import { KIND_LAYOUT, type KnownPage, type Proposal } from "./distill";

export const SUPERSEDE_TITLE_SIMILARITY = 0.6;

function trigrams(title: string): Set<string> {
	const text = ` ${title
		.normalize("NFKC")
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, " ")
		.trim()} `;
	const grams = new Set<string>();
	for (let index = 0; index + 3 <= text.length; index++) grams.add(text.slice(index, index + 3));
	return grams;
}

/** Jaccard similarity of two titles' character trigrams (lowercased, punctuation folded to spaces), 0 to 1. */
export function titleSimilarity(a: string, b: string): number {
	const left = trigrams(a);
	const right = trigrams(b);
	let shared = 0;
	for (const gram of left) if (right.has(gram)) shared += 1;
	const union = left.size + right.size - shared;
	return union === 0 ? 0 : shared / union;
}

/** The page the proposal replaces: the one the model named, else the most similar same-kind title at or above 0.6; never a pinned one. */
export function pageToReplace(
	proposal: Pick<Proposal, "kind" | "title" | "supersedes">,
	known: readonly KnownPage[],
): KnownPage | null {
	const layout = KIND_LAYOUT[proposal.kind];
	const scope = known.filter(page => page.global === layout.global && !page.pinned);
	if (proposal.supersedes) return scope.find(page => page.path === proposal.supersedes) ?? null;
	let best: KnownPage | null = null;
	let bestScore = 0;
	for (const page of scope) {
		if (!page.path.startsWith(`${layout.folder}/`)) continue;
		const score = titleSimilarity(page.title, proposal.title);
		// `known` is newest first: a tie keeps the newer page.
		if (score >= SUPERSEDE_TITLE_SIMILARITY && score > bestScore) {
			best = page;
			bestScore = score;
		}
	}
	return best;
}
