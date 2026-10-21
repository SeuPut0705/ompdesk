/**
 * Whether a finished check run, commit status or workflow run passed, by GitHub's rule for required checks:
 * success, neutral and skipped pass; every other conclusion (failure, cancelled, timed out, action required,
 * stale, error, …) does not. Case-insensitive: the GraphQL rollup spells conclusions in capitals, REST in lowercase.
 */
export function githubConclusionPassed(conclusion: string): boolean {
	const key = conclusion.toLowerCase();
	return key === "success" || key === "neutral" || key === "skipped";
}
