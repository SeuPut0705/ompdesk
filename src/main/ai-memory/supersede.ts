/**
 * Which page memory already holds a new learned page replaces (Graphiti's rule: a newer fact invalidates the old one
 * instead of overwriting it): only the one the model names in `supersedes`, a path it was shown in the page's own scope.
 * No title-similarity fallback: "Run the checks before pushing" and "… before merging" score 0.73 (character-trigram
 * Jaccard) and are two rules, and a replaced page is later deleted by the daily sweep. In the replay of 19 Oct 2026
 * every correct replacement came from the model naming the page. A pinned page is the owner's and is never replaced.
 */
import { KIND_LAYOUT, type KnownPage, type Proposal } from "./distill";

export function pageToReplace(
	proposal: Pick<Proposal, "kind" | "supersedes">,
	known: readonly KnownPage[],
): KnownPage | null {
	if (!proposal.supersedes) return null;
	const layout = KIND_LAYOUT[proposal.kind];
	return (
		known.find(page => page.path === proposal.supersedes && page.global === layout.global && !page.pinned) ?? null
	);
}
