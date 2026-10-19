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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { isNewer } from "../shared/version";
import type { OmpRuntime } from "./local/types";
import { spawnPath } from "./shell-env";
import { isExecutableFile, launcherNames, needsShell, spawnArgs, spawnCommand } from "./spawn";

/**
 * Oldest omp whose RPC surface and bridge-extension internals this GUI is written
 * against. 18.12.2 is the first omp whose `@oh-my-pi/pi-ai` root exports
 * `nativeJudgmentImageBounds` (the judge-model preview check, `capabilities.ts`
 * `judgeAssist`) and whose judge chain starts with a native decision model.
 * Earlier floors: the stock internals the bridge reuses instead of keeping
 * OMPdesk copies (session listing and transcript, worktree root, provider catalog,
 * account matching…), `worktree.onStart`/`onExit` (18.8.6), per-model compaction
 * limits and account identity keys (18.8.7), stock's project-scoped memory backend
 * call (18.11.0).
 */
export const MIN_OMP_VERSION = "18.12.2";

const VERSION_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const INSTALL_HINT = "Install it with `bun install -g @oh-my-pi/pi-coding-agent` (see https://omp.sh), then relaunch.";

/** Why omp is unusable; the GUI localizes this (src/main/i18n.ts `ompFailureText`). `error` stays the English text. */
export type OmpFailure =
	| { kind: "not-found" }
	| { kind: "override-missing"; path: string }
	| { kind: "cannot-run"; bin: string; detail: string }
	| { kind: "too-old"; version: string; minimum: string; bin: string };

export type OmpResolution = { ok: true; runtime: OmpRuntime } | { ok: false; error: string; reason?: OmpFailure };

/** `omp/18.6.1` (or any text carrying a semver) → `18.6.1`. */
export function parseOmpVersion(output: string): string | null {
	return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

interface OmpUpdateCheck {
	currentVersion: string;
	latestVersion: string;
}

/**
 * Stock `omp update --check`: `Current version: X`, then `New version available: Y` or `Already
 * up to date`. Stock picks the registry (.npmrc, bunfig, `npm_config_registry`), the channel
 * (`update.channel`) and, for a standalone binary, the build service: its answer is the one
 * `omp update` acts on.
 */
export function parseUpdateCheck(output: string): OmpUpdateCheck | null {
	const current = /Current version:\s*(\d+\.\d+\.\d+\S*)/.exec(output)?.[1];
	if (!current) return null;
	const latest =
		/New version available:\s*(\d+\.\d+\.\d+\S*)/.exec(output)?.[1] ??
		(/Already up to date/.test(output) ? current : undefined);
	return latest ? { currentVersion: current, latestVersion: latest } : null;
}

/** `basePath` plus the omp directory and `~/.bun/bin`, so the CLI's `env bun` shebang resolves. */
export function ompPathEnv(bin: string, basePath: string): string {
	const entries = basePath.split(delimiter).filter(Boolean);
	for (const dir of [dirname(bin), join(homedir(), ".bun", "bin")]) {
		if (!entries.includes(dir)) entries.push(dir);
	}
	return entries.join(delimiter);
}

/**
 * Added last to the env of every omp OMPdesk runs a session in (tabs, hosted tabs, scheduled runs, benchmarks,
 * model setup, `omp` CLI calls): OTLP telemetry export stays off whatever `OTEL_*` endpoints the user's
 * environment names. Stock's only exporter, `initTelemetryExport` (telemetry-export.ts, called from main.ts
 * after the session options are built, before any extension loads), returns at once when
 * `OTEL_SDK_DISABLED` is `true`; nothing else in stock exports telemetry.
 */
export const OMP_TELEMETRY_OFF = { OTEL_SDK_DISABLED: "true" } as const;

/**
 * What points stock `omp update` (and `--check`) at `bin`'s own install. Stock updates the first `omp` on PATH
 * (`resolveOmpPath` = `$which("omp")`) and calls it a Bun install only when that launcher sits in `bun pm bin -g`
 * (BUN_INSTALL's `bin`); otherwise it routes through npm, Homebrew or a standalone-binary replacement. So `bin`'s
 * directory goes first on `basePath`, and a `bun install -g` launcher (`<root>/bin/omp` beside
 * `<root>/install/global/node_modules/@oh-my-pi/pi-coding-agent`) gets `BUN_INSTALL=<root>`; without these an
 * update could install into another omp than the one OMPdesk runs, or judge the wrong one up to date.
 */
export function ompUpdateEnv(bin: string, basePath: string): { PATH: string; BUN_INSTALL?: string } {
	const own = dirname(bin);
	const rest = basePath.split(delimiter).filter(entry => entry && entry !== own);
	const root = dirname(own);
	const bunGlobal = existsSync(
		join(root, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json"),
	);
	return {
		PATH: ompPathEnv(bin, [own, ...rest].join(delimiter)),
		...(bunGlobal ? { BUN_INSTALL: root } : {}),
	};
}

/** Every location omp may be installed at, in lookup order. */
export function ompCandidates(pathEnv: string, home: string, platform: NodeJS.Platform): string[] {
	const names = launcherNames("omp", platform);
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
	const child = spawn(spawnCommand(bin), spawnArgs(bin, args), {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env, PATH: ompPathEnv(bin, opts.env?.PATH ?? basePath), ...OMP_TELEMETRY_OFF },
		shell: needsShell(bin),
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
		: ompCandidates(basePath, homedir(), process.platform).find(file => isExecutableFile(file, process.platform));
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
	if (isNewer(MIN_OMP_VERSION, version)) {
		return {
			ok: false,
			error: `omp ${version} is too old; this GUI needs omp ${MIN_OMP_VERSION} or newer. Run \`omp update\`, then relaunch.`,
			reason: { kind: "too-old", version, minimum: MIN_OMP_VERSION, bin },
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

/**
 * Resolve omp again, after `omp update` replaced it: the cached resolution
 * carries the old version and the sidecars restart from it. A failed
 * resolution is not cached, like `systemOmp`.
 */
export function refreshSystemOmp(): Promise<OmpResolution> {
	cached = null;
	return systemOmp();
}
