/**
 * Deals test files to shards by measured cost, for the two suites that are split over CI jobs: Playwright's spec
 * files (`scripts/e2e-shard.ts`) and vitest's test files (`scripts/vitest-sequencer.ts`). Heaviest first, each to the
 * shard that is lightest so far (LPT): every file lands in exactly one shard, so a wrong cost moves wall time between
 * shards, never coverage. Ties go by file name in code-unit order, so every job of a run deals the same shards.
 */
export function deal(files: ReadonlyArray<{ file: string; seconds: number }>, total: number): string[][] {
	const shards = Array.from({ length: total }, () => ({ seconds: 0, files: [] as string[] }));
	const ordered = [...files].sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	for (const { file, seconds } of ordered) {
		const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
		lightest.seconds += seconds;
		lightest.files.push(file);
	}
	return shards.map(shard => shard.files.sort());
}
