/**
 * Pool member quick checks: one batched bench per set of unchecked models; a
 * per-model failure (404 etc.) is flagged with its error, a bench that could
 * not run leaves the models unchecked, and checked models are not re-run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcBenchmarkRunOptions, IpcBenchmarkRunResult } from "../../shared/ipc-types";
import { checkResults, useModelPoolChecks } from "./model-pool-checks";

const run = vi.fn(
	async (_options: IpcBenchmarkRunOptions): Promise<IpcBenchmarkRunResult> => ({
		success: false,
		error: "unset",
	}),
);
(globalThis as Record<string, unknown>).window = { omp: { bench: { run } } };

const OK = "anthropic/claude-haiku-4-5";
const MISSING = "anthropic/claude-sonnet-4-0";
const NOT_FOUND = '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-0"}}';

function summary(): IpcBenchmarkRunResult {
	return {
		success: true,
		exitCode: 1,
		summary: {
			runs: 1,
			failures: 1,
			models: [
				{
					selector: MISSING,
					model: MISSING,
					stats: null,
					byChallenge: {},
					results: [{ ok: false, error: NOT_FOUND }],
				},
				{ selector: OK, model: OK, stats: null, byChallenge: {}, results: [{ ok: true }] },
			],
		},
	};
}

async function settled() {
	await vi.waitFor(() => {
		expect(Object.values(useModelPoolChecks.getState().checks).some(check => check.status === "checking")).toBe(
			false,
		);
	});
}

afterEach(() => {
	run.mockReset();
	useModelPoolChecks.getState().reset();
});

describe("checkResults", () => {
	it("reads per-model outcomes and learns nothing from a run that failed", () => {
		const outcomes = checkResults([OK, MISSING, "x/absent"], summary());
		expect(outcomes?.get(OK)).toEqual({ status: "ok" });
		expect(outcomes?.get(MISSING)).toEqual({ status: "failed", error: NOT_FOUND });
		expect(outcomes?.get("x/absent")).toEqual({ status: "failed", error: "No response" });
		expect(checkResults([OK], { success: false, error: "A benchmark is already running" })).toBeNull();
	});
});

describe("model-pool checks store", () => {
	it("checks unchecked models in one tiny bench and caches the result", async () => {
		run.mockResolvedValueOnce(summary());
		useModelPoolChecks.getState().ensure([OK, MISSING]);
		expect(useModelPoolChecks.getState().checks[OK]).toEqual({ status: "checking" });
		await settled();
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0]).toEqual({
			models: [OK, MISSING],
			profile: "chat",
			runs: 1,
			parallel: 2,
			maxTokens: 16,
		});
		expect(useModelPoolChecks.getState().checks).toEqual({
			[OK]: { status: "ok" },
			[MISSING]: { status: "failed", error: NOT_FOUND },
		});

		useModelPoolChecks.getState().ensure([OK, MISSING]);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("leaves models unchecked when the bench cannot run, and rechecks on request", async () => {
		run.mockResolvedValueOnce({ success: false, error: "A benchmark is already running" });
		useModelPoolChecks.getState().ensure([OK]);
		await settled();
		expect(useModelPoolChecks.getState().checks).toEqual({});

		run.mockResolvedValueOnce(summary());
		useModelPoolChecks.getState().recheck(OK);
		await settled();
		expect(run.mock.calls[1]?.[0].models).toEqual([OK]);
		expect(useModelPoolChecks.getState().checks).toEqual({ [OK]: { status: "ok" } });
	});
});
