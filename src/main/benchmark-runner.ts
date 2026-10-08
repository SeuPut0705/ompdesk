import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import { codedError, ipcErrorCode } from "../shared/ipc-error-codes";
import type { IpcBenchmarkRunOptions, IpcBenchmarkRunResult, IpcBenchmarkSummary } from "../shared/ipc-types";
import { ompNeedsShell, ompPathEnv, ompSpawnArgs, ompSpawnCommand } from "./omp-runtime";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const BENCHMARK_TIMEOUT_MS = 15 * 60 * 1000;

function boundedInteger(name: string, value: number, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw codedError("benchmark_invalid_option", `${name} must be between ${min} and ${max}`);
	}
	return value;
}

export function benchmarkArgs(options: IpcBenchmarkRunOptions): string[] {
	if (options.models.length < 1 || options.models.length > 8)
		throw codedError("benchmark_model_count", "Select between 1 and 8 models");
	if (!(["mix", "chat", "prefill", "generation"] as const).includes(options.profile)) {
		throw codedError("benchmark_invalid_option", "Invalid benchmark profile");
	}
	const models = [
		...new Set(
			options.models.map(model => {
				const value = model.trim();
				if (!value || value.length > 200 || value.startsWith("-"))
					throw codedError("benchmark_invalid_model", "Invalid model selector");
				return value;
			}),
		),
	];
	const args = [
		"bench",
		...models,
		"--profile",
		options.profile,
		"--runs",
		String(boundedInteger("runs", options.runs, 1, 20)),
		"--par",
		String(boundedInteger("parallel", options.parallel, 1, 8)),
		"--json",
	];
	if (options.maxTokens !== undefined) {
		args.push("--max-tokens", String(boundedInteger("maxTokens", options.maxTokens, 1, 8192)));
	}
	return args;
}

const metric = z.object({
	mean: z.number().finite(),
	min: z.number().finite(),
	p50: z.number().finite(),
	p95: z.number().finite(),
	max: z.number().finite(),
});
const stats = z.object({
	ttftMs: metric,
	durationMs: metric,
	tokensPerSecond: metric,
	generationTps: metric,
	prefillTps: metric,
	inputTokens: z.number().finite(),
	outputTokens: z.number().finite(),
	cost: z.number().finite(),
});
const summary = z.object({
	runs: z.number().int().positive(),
	failures: z.number().int().nonnegative(),
	profile: z.enum(["mix", "chat", "prefill", "generation"]).optional(),
	models: z.array(
		z.object({
			selector: z.string(),
			model: z.string(),
			stats: stats.nullable(),
			byChallenge: z.record(stats).default({}),
			results: z.array(z.object({ ok: z.boolean(), error: z.string().optional() })),
		}),
	),
});
export function parseBenchmarkSummary(stdout: string): IpcBenchmarkSummary {
	const parsed = summary.safeParse(JSON.parse(stdout));
	if (!parsed.success) throw new Error("Benchmark returned malformed JSON");
	return parsed.data;
}

export class BenchmarkRunner {
	#child: ChildProcess | null = null;
	#terminationReason: string | null = null;

	get running(): boolean {
		return this.#child !== null;
	}

	abort(): boolean {
		return this.#terminate("Benchmark cancelled");
	}

	#terminate(reason: string): boolean {
		const child = this.#child;
		if (!child) return false;
		this.#terminationReason = reason;
		child.kill("SIGTERM");
		const killTimer = setTimeout(() => {
			if (this.#child === child) child.kill("SIGKILL");
		}, 2_000);
		killTimer.unref();
		return true;
	}

	async run(
		ompBin: string,
		cwd: string,
		options: IpcBenchmarkRunOptions,
		env: NodeJS.ProcessEnv,
	): Promise<IpcBenchmarkRunResult> {
		if (this.#child) return { success: false, error: "A benchmark is already running", code: "benchmark_running" };
		let args: string[];
		try {
			args = benchmarkArgs(options);
		} catch (error) {
			const code = ipcErrorCode(error);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				...(code ? { code } : {}),
			};
		}
		this.#terminationReason = null;
		const child = spawn(ompSpawnCommand(ompBin), ompSpawnArgs(ompBin, args), {
			cwd,
			env: { ...env, PATH: ompPathEnv(ompBin, env.PATH ?? "") },
			shell: ompNeedsShell(ompBin),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		this.#child = child;
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let settled = false;
		const { promise, resolve } = Promise.withResolvers<IpcBenchmarkRunResult>();
		const finish = (result: IpcBenchmarkRunResult) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			this.#child = null;
			resolve(result);
		};
		const append = (target: "stdout" | "stderr", chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > MAX_OUTPUT_BYTES) {
				this.#terminate("Benchmark output exceeded 8 MiB");
				return;
			}
			if (target === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};
		child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
		child.once("error", error => finish({ success: false, error: error.message, stderr: stderr || undefined }));
		child.once("close", exitCode => {
			if (this.#terminationReason) {
				finish({ success: false, error: this.#terminationReason, stderr: stderr || undefined });
				return;
			}
			try {
				finish({
					success: true,
					summary: parseBenchmarkSummary(stdout),
					exitCode,
					stderr: stderr.trim() || undefined,
				});
			} catch (error) {
				finish({
					success: false,
					error: error instanceof Error ? error.message : String(error),
					stderr: stderr.trim() || undefined,
				});
			}
		});
		const timeout = setTimeout(() => {
			this.#terminate("Benchmark timed out after 15 minutes");
		}, BENCHMARK_TIMEOUT_MS);
		timeout.unref();
		return promise;
	}
}
