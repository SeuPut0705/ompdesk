/**
 * What a worktree child's `done` or `review` report leaves in git, read when it reports instead of when its opener asks
 * (`ompdesk_compare`): a report that says done while the work sits uncommitted, or names files its change does not
 * hold, is a dropped ball the opener sees at once. Idea after OpenRig's custody check on a queue item's closure
 * (mvschwarz/openrig, docs/as-built/architecture/coordination-primitive.md, Apache-2.0), re-implemented on git facts.
 */
import type { BranchFacts } from "./branches";

export interface Custody {
	/** One line of facts appended to the report the opener reads. */
	line: string;
	/** What the reporter should fix before its report holds, or null when its git agrees with it. */
	gap: string | null;
}

/** A reported path names a changed file when they are equal or one ends with the other at a folder boundary. */
function names(reported: string, changed: string): boolean {
	const a = reported.replaceAll("\\", "/").replace(/^\.\//, "");
	const b = changed.replaceAll("\\", "/");
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function custodyOf(facts: BranchFacts, reported: readonly string[] = []): Custody {
	const parts = [
		facts.merged ? "landed" : `${facts.commitsAhead} commit(s) not in ${facts.baseBranch ?? "the base"} yet`,
		facts.uncommitted ? `${facts.uncommitted} uncommitted file(s)` : null,
		facts.untracked ? `${facts.untracked} untracked file(s)` : null,
	].filter(Boolean);
	// Untracked files are no part of `files` (tracked only), a cut list cannot tell, and a landed branch is measured from
	// its tip (`branchFacts`: only uncommitted work is left in `files`): only a complete, untracked-free change that has
	// not landed can say a reported file is missing from it.
	const missing =
		facts.merged || facts.filesTruncated || facts.untracked > 0
			? []
			: reported.filter(path => !facts.files.some(change => names(path, change.path)));
	if (missing.length) parts.push(`reported but unchanged: ${missing.slice(0, 5).join(", ")}`);
	const gaps = [
		facts.uncommitted || facts.untracked
			? `your worktree still has ${[
					facts.uncommitted ? `${facts.uncommitted} uncommitted` : null,
					facts.untracked ? `${facts.untracked} untracked` : null,
				]
					.filter(Boolean)
					.join(" and ")} file(s): commit what belongs to the work (or say why it stays out)`
			: null,
		missing.length ? `the files you named ${missing.slice(0, 5).join(", ")} are not in your branch's change` : null,
	].filter(Boolean);
	return {
		line: `Git (${facts.branch}): ${parts.join("; ")}.`,
		gap: gaps.length ? `${gaps.join("; ")}.` : null,
	};
}
