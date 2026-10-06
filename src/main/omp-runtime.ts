/**
 * The user's installed omp CLI. The GUI drives the system omp (so `omp update`
 * reaches the GUI directly) instead of bundling an agent build.
 *
 * Resolution: `OMP_GUI_OMP` (dev/test override), then every PATH entry — the
 * inherited PATH merged with the login-shell PATH, because a Finder-launched
 * app inherits launchd's bare PATH — then the well-known install locations.
 * The npm/bun build of omp is a `#!/usr/bin/env bun` script, so every spawn
 * also gets the omp directory and `~/.bun/bin` on its PATH.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { OmpRuntime } from "./local/types";
import { spawnPath } from "./shell-env";

/** Oldest omp whose RPC surface and bridge-extension internals this GUI is written against. */
export const MIN_OMP_VERSION = "18.6.0";

const VERSION_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const INSTALL_HINT = "Install it with `bun install -g @oh-my-pi/pi-coding-agent` (see https://omp.sh), then relaunch.";

/** Why omp is unusable; the GUI localizes this (src/main/i18n.ts `ompFailureText`). `error` stays the English text. */
export type OmpFailure =
	| { kind: "not-found" }
	| { kind: "override-missing"; path: string }
	| { kind: "cannot-run"; bin: string; detail: string }
	| { kind: "too-old"; version: string; minimum: string };

export type OmpResolution = { ok: true; runtime: OmpRuntime } | { ok: false; error: string; reason?: OmpFailure };

/** `omp/18.6.1` (or any text carrying a semver) → `18.6.1`. */
export function parseOmpVersion(output: string): string | null {
	return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

/** Numeric semver compare on major.minor.patch; prerelease tags are ignored. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(part => Number.parseInt(part, 10) || 0);
	const pb = b.split(".").map(part => Number.parseInt(part, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Windows `.cmd`/`.bat` shims only run through cmd.exe. */
export function ompNeedsShell(bin: string): boolean {
	return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

/**
 * cmd.exe re-parses a shell spawn's command line, so each argument is quoted
 * there. Node passes argv verbatim everywhere else.
 */
export function ompSpawnArgs(bin: string, args: string[]): string[] {
	return ompNeedsShell(bin) ? args.map(arg => `"${arg.replace(/"/g, '""')}"`) : args;
}

/** `basePath` plus the omp directory and `~/.bun/bin`, so the CLI's `env bun` shebang resolves. */
export function ompPathEnv(bin: string, basePath: string): string {
	const entries = basePath.split(delimiter).filter(Boolean);
	for (const dir of [dirname(bin), join(homedir(), ".bun", "bin")]) {
		if (!entries.includes(dir)) entries.push(dir);
	}
	return entries.join(delimiter);
}

function isExecutable(file: string): boolean {
	try {
		accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Every location omp may be installed at, in lookup order. */
export function ompCandidates(pathEnv: string, home: string, platform: NodeJS.Platform): string[] {
	const names = platform === "win32" ? ["omp.exe", "omp.cmd"] : ["omp"];
	const dirs = pathEnv.split(delimiter).filter(Boolean);
	const candidates = dirs.flatMap(dir => names.map(name => join(dir, name)));
	if (platform === "win32") {
		const profile = process.env.USERPROFILE || home;
		candidates.push(join(profile, ".bun", "bin", "omp.exe"));
	} else {
		candidates.push(join(home, ".bun", "bin", "omp"), "/opt/homebrew/bin/omp", "/usr/local/bin/omp");
	}
	return candidates;
}

/**
 * The `@oh-my-pi/pi-coding-agent` package directory behind `bin`, or null. A
 * symlinked bin (bun/npm on macOS) resolves to `<root>/dist/cli.js`; bun's
 * Windows `omp.exe` shim lives in `~/.bun/bin` next to `~/.bun/install/global`,
 * and npm's Windows `omp.cmd` sits beside its global `node_modules`.
 */
export function ompPackageRoot(bin: string): string | null {
	const candidates: string[] = [];
	try {
		candidates.push(dirname(dirname(realpathSync(bin))));
	} catch {
		// Unresolvable bin: only the layout guesses remain.
	}
	const binDir = dirname(bin);
	candidates.push(
		join(binDir, "..", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent"),
		join(binDir, "node_modules", "@oh-my-pi", "pi-coding-agent"),
		join(binDir, "..", "lib", "node_modules", "@oh-my-pi", "pi-coding-agent"),
	);
	for (const dir of candidates) {
		try {
			const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (typeof manifest === "object" && manifest !== null && "name" in manifest) {
				if (manifest.name === "@oh-my-pi/pi-coding-agent") return dir;
			}
		} catch {
			// Not this layout.
		}
	}
	return null;
}

function runOmp(
	bin: string,
	args: string[],
	opts: { cwd?: string; input?: string; timeoutMs?: number; env?: Record<string, string> },
	basePath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
	const child = spawn(bin, ompSpawnArgs(bin, args), {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env, PATH: ompPathEnv(bin, opts.env?.PATH ?? basePath) },
		shell: ompNeedsShell(bin),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const timer = setTimeout(() => {
		child.kill();
		reject(new Error(`omp ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
	}, timeoutMs);
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
		resolve({ code: code ?? 1, stdout, stderr });
	});
	child.stdin.end(opts.input ?? "");
	return promise;
}

/** Find omp, run `omp --version`, and gate it on MIN_OMP_VERSION. */
export async function resolveOmp(): Promise<OmpResolution> {
	const basePath = await spawnPath();
	const override = process.env.OMP_GUI_OMP;
	const bin = override
		? existsSync(override)
			? override
			: undefined
		: ompCandidates(basePath, homedir(), process.platform).find(file => existsSync(file) && isExecutable(file));
	if (!bin) {
		return override
			? {
					ok: false,
					error: `OMP_GUI_OMP points at a missing file (${override}).`,
					reason: { kind: "override-missing", path: override },
				}
			: { ok: false, error: `omp not found. ${INSTALL_HINT}`, reason: { kind: "not-found" } };
	}
	let output: { code: number; stdout: string; stderr: string };
	try {
		output = await runOmp(bin, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS }, basePath);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `omp at ${bin} could not run: ${detail}`,
			reason: { kind: "cannot-run", bin, detail },
		};
	}
	const version = output.code === 0 ? parseOmpVersion(output.stdout) : null;
	if (!version) {
		const detail = (output.stderr || output.stdout).trim().split("\n")[0] ?? "";
		return {
			ok: false,
			error: `omp at ${bin} failed \`omp --version\`${detail ? `: ${detail}` : ""}. ${INSTALL_HINT}`,
			reason: { kind: "cannot-run", bin, detail },
		};
	}
	if (compareVersions(version, MIN_OMP_VERSION) < 0) {
		return {
			ok: false,
			error: `omp ${version} is too old; this GUI needs omp ${MIN_OMP_VERSION} or newer. Run \`omp update\`, then relaunch.`,
			reason: { kind: "too-old", version, minimum: MIN_OMP_VERSION },
		};
	}
	return {
		ok: true,
		runtime: { bin, version, run: (args, opts = {}) => runOmp(bin, args, opts, basePath) },
	};
}

let cached: Promise<OmpResolution> | null = null;

/**
 * Process-wide resolution, shared by every sidecar and helper process. A
 * failure is not cached: the next spawn (e.g. a manual restart after the user
 * installs omp) resolves again.
 */
export function systemOmp(): Promise<OmpResolution> {
	if (cached) return cached;
	const pending = resolveOmp();
	cached = pending;
	void pending.then(result => {
		if (!result.ok && cached === pending) cached = null;
	});
	return pending;
}
