/**
 * Finding and starting a command-line tool the way each platform runs it. Windows starts a native `.exe`
 * directly but a `.cmd`/`.bat` shim (npm's, the fake omp's) only through cmd.exe, and the bare `<bin>` npm
 * writes beside a shim is a POSIX shell script it cannot start. Every lookup and spawn of an external tool
 * (omp, git, gh, Bun, npm, winget, the vendor CLIs, MCP runners) goes through these.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Machine setup's `"other"` (neither macOS nor Windows) looks tools up like POSIX. */
type LookupPlatform = NodeJS.Platform | "other";

/** Windows `.cmd`/`.bat` shims only run through cmd.exe. */
export function needsShell(bin: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

/**
 * The spawn command for `bin`. A shell spawn joins command and argv into one
 * cmd.exe line unquoted, so a shim under `C:\Users\First Last\...` would split
 * at the space; quote it there.
 */
export function spawnCommand(bin: string, platform: NodeJS.Platform = process.platform): string {
	return needsShell(bin, platform) ? `"${bin}"` : bin;
}

/**
 * cmd.exe re-parses a shell spawn's command line, so each argument is quoted
 * there. Node passes argv verbatim everywhere else.
 */
export function spawnArgs(bin: string, args: string[], platform: NodeJS.Platform = process.platform): string[] {
	return needsShell(bin, platform) ? args.map(arg => `"${arg.replace(/"/g, '""')}"`) : args;
}

/** A native tool's file name: `<name>.exe` on Windows, the bare name elsewhere. */
export function executableName(name: string, platform: LookupPlatform): string {
	return platform === "win32" ? `${name}.exe` : name;
}

/**
 * The file names a tool that may be a native binary or an npm shim is looked up by: on Windows `<name>.exe`,
 * then `<name>.cmd` (never the bare name, a POSIX shell script there); the bare name elsewhere.
 */
export function launcherNames(name: string, platform: LookupPlatform): string[] {
	return platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
}

/** A file this platform can start: any existing file on Windows, one with an execute bit on POSIX; never a directory. */
export function isExecutableFile(file: string, platform: LookupPlatform): boolean {
	try {
		accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
	} catch {
		return false;
	}
	// An app execution alias (`WindowsApps\winget.exe`) is a reparse point that may refuse a stat: only a
	// directory that stats as one is ruled out.
	try {
		return !statSync(file).isDirectory();
	} catch {
		return true;
	}
}

/**
 * The first `names` entry found along `pathEnv` (each directory tries every name in order), then the first
 * `extra` candidate that exists; never a file listed in `exclude`.
 */
export function findOnPath(
	names: string[],
	pathEnv: string,
	platform: LookupPlatform,
	extra: string[] = [],
	exclude: string[] = [],
): string | null {
	const dirs = pathEnv.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
	const candidates = [...dirs.flatMap(dir => names.map(name => join(dir, name))), ...extra];
	return candidates.find(file => !exclude.includes(file) && isExecutableFile(file, platform)) ?? null;
}
