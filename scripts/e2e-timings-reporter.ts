/**
 * Writes what each spec file cost this shard to `OMPDESK_E2E_TIMINGS_OUT` (playwright.config.ts adds it when that is
 * set): its passed tests' time, summed. The run's `timings` job folds every shard's file into the record the next
 * run's shards are dealt by (`scripts/test-timings.ts`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import type { JobTimings } from "./test-timings";

export default class E2eTimingsReporter implements Reporter {
	readonly #ms = new Map<string, number>();

	onTestEnd(test: TestCase, result: TestResult): void {
		// A failed try ran until it broke or timed out: neither is what the test costs.
		if (result.status !== "passed") return;
		const file = path.relative(process.cwd(), test.location.file).replaceAll("\\", "/");
		this.#ms.set(file, (this.#ms.get(file) ?? 0) + result.duration);
	}

	onEnd(): void {
		const out = process.env.OMPDESK_E2E_TIMINGS_OUT;
		if (!out) return;
		const files = Object.fromEntries([...this.#ms].map(([file, ms]) => [file, Math.round(ms / 100) / 10]));
		const job: JobTimings = { group: "e2e", files };
		mkdirSync(path.dirname(out), { recursive: true });
		writeFileSync(out, `${JSON.stringify(job)}\n`);
	}
}
