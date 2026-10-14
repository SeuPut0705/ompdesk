/**
 * Where setup installs things, and how the processes OMPdesk spawns find
 * them: the managed tools directory (Node and gh archives on macOS without
 * Homebrew, PortableGit on Windows), the Windows registry PATH that installers
 * change while the app runs, and Git Bash discovery on Windows.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SetupPlatform } from "../../shared/setup";
import { resetLoginShellEnvCache } from "../shell-env";

export type Exists = (file: string) => boolean;

export function setupPlatform(platform: NodeJS.Platform = process.platform): SetupPlatform {
	return platform === "darwin" || platform === "win32" ? platform : "other";
}

/**
 * The managed tools directory: `%LOCALAPPDATA%\ompdesk\tools` on Windows (not
 * the roaming profile: PortableGit is ~300 MB of machine-local binaries),
 * `<userData>/tools` elsewhere.
 */
export function managedToolsDir(
	platform: SetupPlatform,
	env: NodeJS.ProcessEnv,
	home: string,
	userData: string,
): string {
	if (platform !== "win32") return join(userData, "tools");
	return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ompdesk", "tools");
}

/** `BUN_INSTALL` (honored by both Bun install scripts) or `~/.bun`. */
export function bunInstallDir(env: NodeJS.ProcessEnv, home: string): string {
	return env.BUN_INSTALL || join(home, ".bun");
}

/** The PortableGit root setup extracts on Windows. */
export function managedGitRoot(toolsDir: string): string {
	return join(toolsDir, "git");
}

/** Directories inside the managed tools dir that belong on a spawned process's PATH. */
export function managedBinDirs(toolsDir: string, platform: SetupPlatform): string[] {
	return platform === "win32"
		? [join(managedGitRoot(toolsDir), "cmd")]
		: [join(toolsDir, "node", "bin"), join(toolsDir, "gh", "bin")];
}

/** `base` plus every `addition` it lacks, in order (case-insensitive on Windows, like its PATH). */
export function mergePathLists(
	base: string,
	additions: string[],
	platform: SetupPlatform,
	sep = platform === "win32" ? ";" : ":",
): string {
	const entries = base.split(sep).filter(Boolean);
	const key = (entry: string) => (platform === "win32" ? entry.replace(/[\\/]+$/, "").toLowerCase() : entry);
	const seen = new Set(entries.map(key));
	for (const addition of additions) {
		for (const entry of addition.split(sep).filter(Boolean)) {
			if (seen.has(key(entry))) continue;
			seen.add(key(entry));
			entries.push(entry);
		}
	}
	return entries.join(sep);
}

/**
 * The env every process OMPdesk spawns needs for the managed tools: their bin
 * directories appended to PATH (the user's own installs keep winning), and on
 * Windows `GIT_INSTALL_ROOT` at the managed PortableGit, which stock omp's
 * `resolveWindowsShell` (pi-utils procmgr.ts) checks after the Git for Windows
 * install roots and before PATH. A user-set `GIT_INSTALL_ROOT` stays.
 */
export function managedToolEnv(
	env: NodeJS.ProcessEnv,
	toolsDir: string,
	platform: SetupPlatform,
	exists: Exists = existsSync,
): { PATH: string; GIT_INSTALL_ROOT?: string } {
	const PATH = mergePathLists(
		env.PATH ?? "",
		managedBinDirs(toolsDir, platform).filter(dir => exists(dir)),
		platform,
	);
	const gitRoot = managedGitRoot(toolsDir);
	if (platform === "win32" && !env.GIT_INSTALL_ROOT && exists(join(gitRoot, "bin", "bash.exe"))) {
		return { PATH, GIT_INSTALL_ROOT: gitRoot };
	}
	return { PATH };
}

/** Apply managedToolEnv to this process, so every later spawn inherits it. */
export function applyManagedToolEnv(toolsDir: string, platform: SetupPlatform): void {
	Object.assign(process.env, managedToolEnv(process.env, toolsDir, platform));
}

/**
 * Git for Windows' bash.exe, or null. OMPdesk copy of the Git-root part of
 * stock `resolveWindowsShell` (pi-utils `procmgr.ts`): setup decides before
 * omp exists whether Git must be installed. Stock then falls back to any
 * bash.exe/sh.exe on PATH, which includes WSL's System32 launcher, so only a
 * `git.exe` on PATH whose install has `bin\bash.exe` counts here.
 * `setup-paths.test.ts` pins the root order against stock.
 */
export function findGitBash(env: NodeJS.ProcessEnv, exists: Exists = existsSync): string | null {
	const roots = [
		env.ProgramFiles && join(env.ProgramFiles, "Git"),
		env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git"),
		env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git"),
		env.GIT_INSTALL_ROOT,
		env.SCOOP && join(env.SCOOP, "apps", "git", "current"),
		env.USERPROFILE && join(env.USERPROFILE, "scoop", "apps", "git", "current"),
	];
	for (const root of roots) {
		if (!root) continue;
		const bash = join(root, "bin", "bash.exe");
		if (exists(bash)) return bash;
	}
	for (const dir of (env.PATH ?? "").split(";").filter(Boolean)) {
		if (!exists(join(dir, "git.exe"))) continue;
		const bash = join(dirname(dir), "bin", "bash.exe");
		if (exists(bash)) return bash;
	}
	return null;
}

/** The value of `name` in `reg query … /v <name>` output, or null. */
export function parseRegQueryValue(output: string, name: string): string | null {
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
		if (match && match[1]?.toLowerCase() === name.toLowerCase()) return match[2]?.trim() ?? "";
	}
	return null;
}

/** Expand `%VAR%` references the way Windows does for REG_EXPAND_SZ (names case-insensitive; unknown ones stay). */
export function expandWindowsEnv(value: string, env: NodeJS.ProcessEnv): string {
	const lookup = new Map(Object.entries(env).map(([key, entry]) => [key.toLowerCase(), entry]));
	return value.replace(/%([^%;]+)%/g, (whole, name: string) => lookup.get(name.toLowerCase()) ?? whole);
}

const MACHINE_ENV_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const USER_ENV_KEY = "HKCU\\Environment";

function regQuery(key: string): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	execFile("reg.exe", ["query", key, "/v", "Path"], { windowsHide: true, timeout: 10_000 }, (error, stdout) =>
		resolve(error ? "" : stdout),
	);
	return promise;
}

/**
 * Pick up PATH changes an installer just made, without an app restart. macOS:
 * drop the cached login-shell probe, so the next spawn re-reads the rc files
 * (Bun's script adds `~/.bun/bin` there). Windows: merge the registry's
 * machine and user PATH into this process's PATH (winget and Bun's script
 * write them there), then re-apply the managed tools.
 */
export async function refreshPath(platform: SetupPlatform, toolsDir: string): Promise<void> {
	if (platform === "win32") {
		const [machine, user] = await Promise.all([regQuery(MACHINE_ENV_KEY), regQuery(USER_ENV_KEY)]);
		const additions = [parseRegQueryValue(machine, "Path"), parseRegQueryValue(user, "Path")]
			.filter((value): value is string => value !== null)
			.map(value => expandWindowsEnv(value, process.env));
		process.env.PATH = mergePathLists(process.env.PATH ?? "", additions, platform);
	} else {
		resetLoginShellEnvCache();
	}
	applyManagedToolEnv(toolsDir, platform);
}
