/**
 * vitest's file sequencer for this repository (`sequence.sequencer` in vitest.config.ts): what `--shard=i/n` gives each
 * CI job, and in what order a run starts its files.
 *
 * vitest's own shard sorts the files by a hash of their path and cuts the list into equal counts. The node project's
 * time is in a few dozen files (the `*-stock` suites on Linux, the git-driven ones on Windows: 135 of 590 files are
 * 95 % of it), so equal counts were unequal work: ci run 42660216414 ran 905 s of tests in `check (node 1/2)` and
 * 538 s in `check (node 2/2)`, 288 s against 197 s of wall time, and the push waited for the longer one. Here whole
 * files are dealt by measured cost (`scripts/shard-deal.ts`, the dealer of the Playwright shards), from
 * `scripts/vitest-shard-costs.json`: each file's seconds on the hosted runner, per platform, rewritten from a run's
 * logs by `bun scripts/vitest-shard-costs.ts <run-id>`. A cost only steers the split: every file is in exactly one
 * shard, whatever the costs say.
 *
 * The order is vitest's (a file that failed last time first, then the longest first), with the measured cost standing
 * in where the run has no cached duration: a Linux job starts from a fresh checkout, sorted by file size, and its
 * last half minute ran one or two long files beside idle workers.
 */
import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { deal } from "./shard-deal";
import costs from "./vitest-shard-costs.json";

const MEASURED: Readonly<Record<string, number>> = process.platform === "win32" ? costs.win32 : costs.linux;
/** What a file under the costs file's floor (2 s) is taken to run: the mean of those files on the runner. */
const UNMEASURED_SECONDS = 0.3;
/** A worker's time for a file before its first test (its process, setup files, imports): the run's total over its files. */
const FILE_OVERHEAD_SECONDS = 0.5;

/** The estimated seconds of a test file, by its path from the repository root with forward slashes. */
export function fileSeconds(file: string, measured: Readonly<Record<string, number>> = MEASURED): number {
	return (measured[file] ?? UNMEASURED_SECONDS) + FILE_OVERHEAD_SECONDS;
}

export class CostSequencer extends BaseSequencer {
	#file(spec: TestSpecification): string {
		return path.relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/");
	}

	override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
		const shard = this.ctx.config.shard;
		if (!shard) return files;
		// One project's file is one entry: the same path in two projects would be two runs.
		const key = (spec: TestSpecification) => `${spec.project.name}:${this.#file(spec)}`;
		const mine = new Set(
			deal(
				files.map(spec => ({ file: key(spec), seconds: fileSeconds(this.#file(spec)) })),
				shard.count,
			)[shard.index - 1],
		);
		return files.filter(spec => mine.has(key(spec)));
	}

	override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
		const order = files.map(spec => {
			const file = this.#file(spec);
			const cached = this.ctx.cache.getFileTestResults(`${spec.project.name}:${file}`);
			return { spec, failed: cached?.failed ?? false, ms: cached?.duration ?? fileSeconds(file) * 1000 };
		});
		return order.sort((a, b) => Number(b.failed) - Number(a.failed) || b.ms - a.ms).map(entry => entry.spec);
	}
}
