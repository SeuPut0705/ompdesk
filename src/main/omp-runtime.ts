/**
 * The user's installed omp CLI. The GUI drives the system omp (so `omp update`
 * reaches the GUI directly) instead of bundling an agent build.
 *
 * Resolution: `OMP_GUI_OMP` (dev/test override), then every PATH entry — the
 * inherited PATH merged with the login-shell PATH, because a Finder-launched
 * app inherits launchd's bare PATH — then the well-known install locations.
 * The npm/bun build of omp is a `#!/usr/bin/env bun` script, so every spawn
 * also gets the omp directory and `~/.bun/bin` on its PATH.
 *
 * Only an omp that runs from its package counts: the bridge (`omp -e`) imports
 * `@oh-my-pi/*`, which a compiled omp (Bun's standalone build, what stock's
 * installer, Homebrew, mise and stock's own launcher repair install) cannot
 * resolve. A compiled omp earlier in the lookup is passed over; with none other
 * the resolution fails `compiled` and machine setup reinstalls the package.
 * The package's `engines.bun` gates the Bun that would run it the same way.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { isNewer } from "../shared/version";
import type { OmpRuntime } from "./local/types";
import { bunInstallDir } from "./setup/paths";
import { spawnPath } from "./shell-env";
import {
	executableName,
	findOnPath,
	isExecutableFile,
	launcherNames,
	needsShell,
	spawnArgs,
	spawnCommand,
} from "./spawn";

/**
 * Oldest omp whose RPC surface and bridge-extension internals this GUI is written
 * against. 18.12.6 is the first omp with pi-catalog's `isPromptCachePersistent`, which
 * idle compaction asks so it never throws away a logged-in Codex session's warm cache
 * (stock's own rule since that release, `idle-compaction-core.ts`).
 * Earlier floors: 18.12.3's `always-ask-cached` ("Ask and remember") tool approval mode
 * the composer offers (`src/shared/tool-approval.ts`); 18.12.2's `@oh-my-pi/pi-ai` `nativeJudgmentImageBounds` (the
 * judge-model preview check, `capabilities.ts` `judgeAssist`); the stock internals
 * the bridge reuses instead of keeping OMPdesk copies (session listing and
 * transcript, worktree root, provider catalog, account matching…),
 * `worktree.onStart`/`onExit` (18.8.6), per-model compaction limits and account
 * identity keys (18.8.7), stock's project-scoped memory backend call (18.11.0).
 */
export const MIN_OMP_VERSION = "18.12.6";

const VERSION_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const INSTALL_HINT = "OMPdesk's machine setup installs the omp package on its own.";

/** Why omp is unusable; the GUI localizes this (src/main/i18n.ts `ompFailureText`). `error` stays the English text. */
export type OmpFailure =
	| { kind: "not-found" }
	| { kind: "override-missing"; path: string }
	| { kind: "cannot-run"; bin: string; detail: string }
	| { kind: "too-old"; version: string; minimum: string; bin: string }
	/** Only a compiled omp (Bun's standalone build) was found; the bridge cannot load into it. */
	| { kind: "compiled"; bin: string }
	/** The package's `engines.bun` names a newer Bun than `bun` (the one that would run it), which omp refuses. */
	| { kind: "bun-too-old"; bin: string; bun: string; bunVersion: string; minimum: string };

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

/**
 * `basePath` plus the omp directory and Bun's bin directory (`BUN_INSTALL` or `~/.bun`, the rule setup installs Bun
 * by), so the CLI's `env bun` shebang resolves, and any `extra` folder a session's tools need that the login shell's
 * PATH may lack (ego-browser's).
 */
export function ompPathEnv(
	bin: string,
	basePath: string,
	extra: readonly string[] = [],
	env: NodeJS.ProcessEnv = process.env,
): string {
	const entries = basePath.split(delimiter).filter(Boolean);
	for (const dir of [dirname(bin), join(bunInstallDir(env, homedir()), "bin"), ...extra]) {
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
 * Bun settings a session's omp starts with, under anything the user's own environment sets. On Windows bun's
 * transpiler cache is off: omp's start with an empty cache (right after `omp update`, or any bridge file change) took
 * about 4 s longer than with none while thousands of small cache files were written, and a warm cache was still
 * ~0.4 s slower than none (measured, omp 18.12.3 on bun 1.4.3, 16-thread Ryzen with Defender on). macOS keeps bun's
 * default: not measured there.
 */
export function ompBunDefaults(platform: NodeJS.Platform = process.platform): Record<string, string> {
	return platform === "win32" ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } : {};
}

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
 * Whether `file` is a compiled omp: Bun's standalone build (`bun build --compile`), which embeds omp's modules
 * under `/$bunfs` where the bridge's `@oh-my-pi/*` imports cannot reach them. A bun or npm install launches omp
 * through its `#!/usr/bin/env bun` script (a symlink to `dist/cli.js` on POSIX, an npm `.cmd`), so on POSIX any
 * native executable is a compiled omp. On Windows bun's launcher is itself a PE (`bun_shim_impl.exe` beside
 * `omp.bunx`), so there it is a PE carrying the `.bun` section a compiled Bun program keeps its module graph in.
 */
export function isCompiledOmp(file: string, platform: NodeJS.Platform = process.platform): boolean {
	const head = Buffer.alloc(4096);
	let read: number;
	try {
		const fd = openSync(file, "r");
		try {
			read = readSync(fd, head, 0, head.length, 0);
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
	if (read < 4) return false;
	if (platform === "win32") {
		if (head.toString("latin1", 0, 2) !== "MZ" || read < 0x40) return false;
		const pe = head.readUInt32LE(0x3c);
		if (pe + 24 > read || head.toString("latin1", pe, pe + 4) !== "PE\0\0") return false;
		const sections = head.readUInt16LE(pe + 6);
		const table = pe + 24 + head.readUInt16LE(pe + 20);
		for (let index = 0; index < sections && table + (index + 1) * 40 <= read; index++) {
			if (head.toString("latin1", table + index * 40, table + index * 40 + 8) === ".bun\0\0\0\0") return true;
		}
		return false;
	}
	if (head.toString("latin1", 0, 4) === "\x7fELF") return true;
	return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(head.readUInt32BE(0));
}

/** The first of `candidates` that runs from its package, and the first compiled one passed over on the way. */
export function pickOmp(
	candidates: readonly string[],
	platform: NodeJS.Platform = process.platform,
): { bin: string | null; compiled: string | null } {
	let compiled: string | null = null;
	for (const file of candidates) {
		if (!isCompiledOmp(file, platform)) return { bin: file, compiled };
		compiled ??= file;
	}
	return { bin: null, compiled };
}

/**
 * The oldest Bun an omp package manifest names in `engines.bun` (stock publishes `>=X.Y.Z`, and its CLI exits
 * on an older Bun: "Bun runtime must be >= X.Y.Z"); null without one or for another range form.
 */
export function manifestBunMinimum(manifest: unknown): string | null {
	const engines = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "engines") : null;
	const range = typeof engines === "object" && engines !== null ? Reflect.get(engines, "bun") : null;
	return typeof range === "string" ? (/^\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/.exec(range)?.[1] ?? null) : null;
}

/** `manifestBunMinimum` of the omp package installed at `root`; null without one. */
export function ompBunMinimum(root: string | null): string | null {
	if (!root) return null;
	try {
		return manifestBunMinimum(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
	} catch {
		return null;
	}
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

/**
 * The version of the package a symlinked `bin` runs (bun's and npm's global install on macOS: `<root>/dist/cli.js`),
 * read from its package.json; null for any other layout. Measured on an M4 Mac (omp 18.12.5): `omp --version`
 * takes 0.3 s, all of it in front of the first session's start, and the manifest is what it prints. Only the file the
 * bin resolves to counts, never a layout guess (`ompPackageRoot`'s): a guess could name a package this bin does not run.
 */
function installedVersion(bin: string): string | null {
	try {
		const root = dirname(dirname(realpathSync(bin)));
		const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (typeof manifest !== "object" || manifest === null) return null;
		const { name, version } = manifest as { name?: unknown; version?: unknown };
		return name === "@oh-my-pi/pi-coding-agent" && typeof version === "string" ? parseOmpVersion(version) : null;
	} catch {
		return null;
	}
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
	const candidates = override
		? existsSync(override)
			? [override]
			: []
		: ompCandidates(basePath, homedir(), process.platform).filter(file => isExecutableFile(file, process.platform));
	const { bin, compiled } = pickOmp(candidates);
	if (!bin) {
		if (compiled) {
			return {
				ok: false,
				error: `omp at ${compiled} is a compiled build, which OMPdesk cannot load its bridge into. ${INSTALL_HINT}`,
				reason: { kind: "compiled", bin: compiled },
			};
		}
		return override
			? {
					ok: false,
					error: `OMP_GUI_OMP points at a missing file (${override}).`,
					reason: { kind: "override-missing", path: override },
				}
			: { ok: false, error: `omp not found. ${INSTALL_HINT}`, reason: { kind: "not-found" } };
	}
	const bunMinimum = ompBunMinimum(ompPackageRoot(bin));
	// The Bun omp's `env bun` shebang (or bun's Windows launcher) finds on the PATH omp is spawned with.
	const bun = bunMinimum
		? findOnPath([executableName("bun", process.platform)], ompPathEnv(bin, basePath), process.platform)
		: null;
	if (bunMinimum && bun) {
		const { promise, resolve } = Promise.withResolvers<string | null>();
		execFile(bun, ["--version"], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
			resolve(error ? null : parseOmpVersion(stdout)),
		);
		const bunVersion = await promise;
		if (bunVersion && isNewer(bunMinimum, bunVersion)) {
			return {
				ok: false,
				error: `omp at ${bin} needs Bun ${bunMinimum} or newer, but ${bun} is ${bunVersion}. OMPdesk's machine setup upgrades Bun on its own.`,
				reason: { kind: "bun-too-old", bin, bun, bunVersion, minimum: bunMinimum },
			};
		}
	}
	let version = installedVersion(bin);
	if (!version) {
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
		version = output.code === 0 ? parseOmpVersion(output.stdout) : null;
		if (!version) {
			const detail = (output.stderr || output.stdout).trim().split("\n")[0] ?? "";
			return {
				ok: false,
				error: `omp at ${bin} failed \`omp --version\`${detail ? `: ${detail}` : ""}. ${INSTALL_HINT}`,
				reason: { kind: "cannot-run", bin, detail },
			};
		}
	}
	if (isNewer(MIN_OMP_VERSION, version)) {
		return {
			ok: false,
			error: `omp ${version} is too old; this GUI needs omp ${MIN_OMP_VERSION} or newer. OMPdesk updates it on its own.`,
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
