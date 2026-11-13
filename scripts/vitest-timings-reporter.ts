/**
 * Writes what each test file cost this job to `OMPDESK_TEST_TIMINGS_OUT` (vitest.config.ts adds it when that is set):
 * the worker's whole time for the file, not its tests alone, because that is what a shard's wall time is made of (the
 * renderer's shard 2/2 in ci run 43482864186: 303 files, 95 s of tests, 150 s of imports, 60 s of setup files). The
 * run's `timings` job folds every job's file into the record the next run's shards are dealt by
 * (`scripts/test-timings.ts`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import type { JobTimings } from "./test-timings";

export class TimingsReporter implements Reporter {
	readonly #out: string;
	readonly #files: Record<string, number> = {};

	constructor(out: string) {
		this.#out = out;
	}

	onTestModuleEnd(module: TestModule): void {
		// A failed file ran until it broke or timed out: neither is what it costs.
		if (!module.ok()) return;
		const spent = module.diagnostic();
		const ms =
			spent.environmentSetupDuration +
			spent.prepareDuration +
			spent.collectDuration +
			spent.setupDuration +
			spent.duration;
		const file = path.relative(module.project.config.root, module.moduleId).replaceAll("\\", "/");
		this.#files[file] = Math.round(ms / 100) / 10;
	}

	onTestRunEnd(): void {
		const job: JobTimings = { group: process.platform === "win32" ? "win32" : "linux", files: this.#files };
		mkdirSync(path.dirname(this.#out), { recursive: true });
		writeFileSync(this.#out, `${JSON.stringify(job)}\n`);
	}
}
