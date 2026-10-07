/**
 * Stock `omp --mode rpc-ui` exits before `ready` when no model has credentials
 * ("No default model selected…" since 18.7, "No models available…" before), so
 * a first-run user would never reach the onboarding dialog that connects a
 * provider. An explicit `--model` boots it unauthenticated. The selector comes
 * from the installed omp's catalog (resources/gui-bridge/boot-model.ts), once
 * per omp install and version.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { OmpRuntime } from "./local/types";
import { ompPackageRoot, ompPathEnv } from "./omp-runtime";
import { spawnPath } from "./shell-env";

/** Used only when the installed omp's catalog cannot be read. */
export const FALLBACK_BOOT_MODEL = "anthropic/claude-sonnet-4-5";

const RESOLVE_TIMEOUT_MS = 15_000;
const SELECTOR_RE = /^[\w.-]+\/\S+$/;

/**
 * Stock omp has no exit code or flag for "no usable model": its non-interactive
 * startup prints a headline and exits 1. Matches every headline spelling —
 * "No default model selected." (18.7+), "No models available." (18.6), "No
 * model available matching enabledModels …" — plus the API-key footer that
 * stock appends to all of them, so a reworded headline still recovers. No
 * leading `\b`: omp colors the lines, and the ANSI code ends in a letter
 * (`\x1b[31mNo models…`).
 */
export function isNoModelBootFailure(stderr: string): boolean {
	return /No models? available\b|No default model selected\b|Set an API key environment variable:/.test(stderr);
}

function runBootModelScript(script: string, packageRoot: string, path: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn("bun", [script], {
		env: { ...process.env, PATH: path, OMP_PACKAGE_ROOT: packageRoot },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const timer = setTimeout(() => {
		child.kill();
		reject(new Error(`timed out after ${RESOLVE_TIMEOUT_MS}ms`));
	}, RESOLVE_TIMEOUT_MS);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("error", err => {
		clearTimeout(timer);
		reject(err);
	});
	child.on("close", code => {
		clearTimeout(timer);
		const selector = stdout.trim();
		if (code === 0 && SELECTOR_RE.test(selector)) resolve(selector);
		else reject(new Error(`exit ${code}: ${(stderr || stdout).trim().split("\n")[0] ?? ""}`));
	});
	return promise;
}

const cache = new Map<string, Promise<string>>();

/** A catalog `provider/model` selector for booting `runtime` without credentials; never rejects. */
export function bootModelSelector(runtime: OmpRuntime, bridgeDir: string): Promise<string> {
	const key = `${runtime.bin}@${runtime.version}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const pending = (async () => {
		const packageRoot = ompPackageRoot(runtime.bin);
		if (!packageRoot) throw new Error(`cannot locate the omp package behind ${runtime.bin}`);
		const path = ompPathEnv(runtime.bin, await spawnPath());
		return runBootModelScript(join(bridgeDir, "boot-model.ts"), packageRoot, path);
	})().catch((err: unknown) => {
		const detail = err instanceof Error ? err.message : String(err);
		console.warn(`[boot-model] catalog lookup failed (${detail}); using ${FALLBACK_BOOT_MODEL}`);
		return FALLBACK_BOOT_MODEL;
	});
	cache.set(key, pending);
	return pending;
}
