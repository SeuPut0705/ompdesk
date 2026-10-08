/**
 * Quick validation of model-pool members: when a model joins a pool, one tiny
 * request (the first-run "Test connection" path: `omp bench`, chat profile,
 * one run, 16 tokens) tells whether the user's account can actually serve it,
 * so the pool UI can warn before a subtask fails on a 404. Results are per
 * selector and machine for this app run (a paired host's accounts are its
 * own, and its bench runs there); models still unchecked are batched into one
 * bench. A bench that could not run at all (another benchmark is running, no
 * workspace) leaves the models unchecked rather than marking them failed.
 */
import { create } from "zustand";
import type { IpcBenchmarkRunResult } from "../../shared/ipc-types";

export type PoolModelCheck = { status: "checking" } | { status: "ok" } | { status: "failed"; error: string };

interface ModelPoolChecksStore {
	/** Keyed by `poolCheckKey(selector, device)`. */
	checks: Record<string, PoolModelCheck>;
	/** Check every selector with no result yet on `device` (a paired host; absent = this device). */
	ensure: (selectors: readonly string[], device?: string) => void;
	/** Drop a result and check the model again. */
	recheck: (selector: string, device?: string) => void;
	reset: () => void;
}

/** A check's entry: the selector on this device, scoped by the paired host otherwise. */
export function poolCheckKey(selector: string, device: string | undefined): string {
	return device ? `${device}\u0000${selector}` : selector;
}

const BENCH_MAX_MODELS = 8;

/** One bench per window at a time (main's BenchmarkRunner refuses overlaps). */
let queue: Promise<void> = Promise.resolve();

/** Per-selector outcome of a bench run; `null` = the run itself failed, nothing learned. */
export function checkResults(
	selectors: readonly string[],
	result: IpcBenchmarkRunResult,
): Map<string, PoolModelCheck> | null {
	if (!result.success) return null;
	const outcomes = new Map<string, PoolModelCheck>();
	for (const selector of selectors) {
		const report = result.summary.models.find(model => model.selector === selector);
		const failure = report?.results.find(item => !item.ok);
		if (report && report.results.length > 0 && !failure) outcomes.set(selector, { status: "ok" });
		else outcomes.set(selector, { status: "failed", error: failure?.error?.trim() || "No response" });
	}
	return outcomes;
}

export const useModelPoolChecks = create<ModelPoolChecksStore>()((set, get) => {
	const run = (selectors: string[], device: string | undefined) => {
		queue = queue.then(async () => {
			let result: IpcBenchmarkRunResult;
			try {
				result = await window.omp.bench.run(
					{
						models: selectors,
						profile: "chat",
						runs: 1,
						parallel: selectors.length,
						maxTokens: 16,
					},
					device,
				);
			} catch (cause) {
				result = { success: false, error: cause instanceof Error ? cause.message : String(cause) };
			}
			const outcomes = checkResults(selectors, result);
			set(state => {
				const checks = { ...state.checks };
				for (const selector of selectors) {
					const key = poolCheckKey(selector, device);
					// A recheck or reset since this run started owns the entry now.
					if (checks[key]?.status !== "checking") continue;
					const outcome = outcomes?.get(selector);
					if (outcome) checks[key] = outcome;
					else delete checks[key];
				}
				return { checks };
			});
		});
	};

	return {
		checks: {},
		ensure: (selectors, device) => {
			const { checks } = get();
			const unchecked = [...new Set(selectors)].filter(selector => !checks[poolCheckKey(selector, device)]);
			if (unchecked.length === 0) return;
			set(state => {
				const next = { ...state.checks };
				for (const selector of unchecked) next[poolCheckKey(selector, device)] = { status: "checking" };
				return { checks: next };
			});
			for (let i = 0; i < unchecked.length; i += BENCH_MAX_MODELS) {
				run(unchecked.slice(i, i + BENCH_MAX_MODELS), device);
			}
		},
		recheck: (selector, device) => {
			set(state => {
				const checks = { ...state.checks };
				delete checks[poolCheckKey(selector, device)];
				return { checks };
			});
			get().ensure([selector], device);
		},
		reset: () => set({ checks: {} }),
	};
});
