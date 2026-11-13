/**
 * vitest's file sequencer for this repository (`sequence.sequencer` in vitest.config.ts): what `--shard=i/n` gives each
 * CI job, and in what order a run starts its files.
 *
 * vitest's own shard sorts the files by a hash of their path and cuts the list into equal counts. The node project's
 * time is in a few dozen files (the `*-stock` suites on Linux, the git-driven ones on Windows: 135 of 590 files are
 * 95 % of it), so equal counts were unequal work: ci run 42660216414 ran 905 s of tests in `check (node 1/2)` and
 * 538 s in `check (node 2/2)`, 288 s against 197 s of wall time, and the push waited for the longer one. Here whole
 * files are dealt by recorded cost (`scripts/shard-deal.ts`, the dealer of the Playwright shards): the record the
 * run's `plan` job handed every job (`OMPDESK_TEST_TIMINGS`, `scripts/test-timings.ts`), else its snapshot
 * `scripts/vitest-shard-costs.json`. A snapshot three days old had drifted until the node project's two shards were
 * dealt 847 and 1302 s of the 1849 s that ci run 43482864186 measured (366 s against 266 s of job time); dealt by the
 * run before it they would have been 1011 and 1138 s. A cost only steers the split: every file is in exactly one
 * shard, whatever the costs say.
 *
 * The order is a file that failed last time first, then the longest first, so no worker ends the run alone on a long
 * file it started late.
 */
import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { deal } from "./shard-deal";
import { loadTimings, UNMEASURED_SECONDS } from "./test-timings";
import seed from "./vitest-shard-costs.json";

const MEASURED = loadTimings(process.env.OMPDESK_TEST_TIMINGS, seed)[process.platform === "win32" ? "win32" : "linux"];

export class CostSequencer extends BaseSequencer {
	#file(spec: TestSpecification): string {
		return path.relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/");
	}

	#seconds(spec: TestSpecification): number {
		return MEASURED?.[this.#file(spec)] ?? UNMEASURED_SECONDS;
	}

	override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
		const shard = this.ctx.config.shard;
		if (!shard) return files;
		// One project's file is one entry: the same path in two projects would be two runs.
		const key = (spec: TestSpecification) => `${spec.project.name}:${this.#file(spec)}`;
		const mine = new Set(
			deal(
				files.map(spec => ({ file: key(spec), seconds: this.#seconds(spec) })),
				shard.count,
			)[shard.index - 1],
		);
		return files.filter(spec => mine.has(key(spec)));
	}

	override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
		const order = files.map(spec => ({
			spec,
			failed: this.ctx.cache.getFileTestResults(`${spec.project.name}:${this.#file(spec)}`)?.failed ?? false,
			seconds: this.#seconds(spec),
		}));
		return order
			.sort((a, b) => Number(b.failed) - Number(a.failed) || b.seconds - a.seconds)
			.map(entry => entry.spec);
	}
}
