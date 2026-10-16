/**
 * What this machine has: Bun, omp (through omp-runtime's own resolution and
 * version gate), Git, GitHub CLI and Node.js (through the built-in REA probe),
 * plus the package managers setup may use (Homebrew, winget).
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { REA_NODE_REQUIREMENT } from "../../shared/builtin-mcp";
import type { SetupItemId, SetupPlatform, SetupPresence } from "../../shared/setup";
import { builtinReaState, resetReaRuntimeCache } from "../builtin-mcp";
import { ompNeedsShell, ompSpawnArgs, ompSpawnCommand, parseOmpVersion, resolveOmp } from "../omp-runtime";
import { brewBinDirs, spawnPath } from "../shell-env";
import { findGitBash } from "./paths";

export interface Detection {
	presence: Record<SetupItemId, SetupPresence>;
	bun: string | null;
	omp: string | null;
	brew: string | null;
	winget: string | null;
}

function executable(file: string, platform: SetupPlatform): boolean {
	try {
		accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The first `names` entry found along `pathEnv`, then the first existing `extra` candidate. */
export function findExecutable(
	names: string[],
	pathEnv: string,
	platform: SetupPlatform,
	extra: string[] = [],
	exclude: string[] = [],
): string | null {
	const dirs = pathEnv.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
	const candidates = [...dirs.flatMap(dir => names.map(name => join(dir, name))), ...extra];
	return candidates.find(file => !exclude.includes(file) && executable(file, platform)) ?? null;
}

/** `<bin> <args>` stdout (first line), or throws. */
function probe(bin: string, args: string[], env: NodeJS.ProcessEnv, platform: SetupPlatform): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const target = platform === "win32" ? "win32" : "darwin";
	execFile(
		ompSpawnCommand(bin, target),
		ompSpawnArgs(bin, args, target),
		{ env, shell: ompNeedsShell(bin, target), timeout: 15_000, windowsHide: true },
		(error, stdout, stderr) => {
			if (error) reject(new Error((stderr || error.message).trim().split("\n")[0] ?? error.message));
			else resolve(stdout.trim());
		},
	);
	return promise;
}

async function versionOf(bin: string, env: NodeJS.ProcessEnv, platform: SetupPlatform): Promise<SetupPresence> {
	try {
		return { kind: "present", version: parseOmpVersion(await probe(bin, ["--version"], env, platform)), path: bin };
	} catch (error) {
		return { kind: "broken", detail: error instanceof Error ? error.message : String(error), path: bin };
	}
}

async function detectOmp(): Promise<{ presence: SetupPresence; bin: string | null }> {
	const resolution = await resolveOmp();
	if (resolution.ok) {
		return {
			presence: { kind: "present", version: resolution.runtime.version, path: resolution.runtime.bin },
			bin: resolution.runtime.bin,
		};
	}
	const reason = resolution.reason;
	switch (reason?.kind) {
		case "too-old":
			return {
				presence: { kind: "outdated", version: reason.version, minimum: reason.minimum, path: reason.bin },
				bin: reason.bin,
			};
		case "cannot-run":
			return { presence: { kind: "broken", detail: reason.detail, path: reason.bin }, bin: null };
		default:
			return { presence: { kind: "missing" }, bin: null };
	}
}

async function detectGit(platform: SetupPlatform, pathEnv: string, env: NodeJS.ProcessEnv): Promise<SetupPresence> {
	if (platform === "win32") {
		const bash = findGitBash({ ...env, PATH: pathEnv });
		if (!bash) return { kind: "missing" };
		const git = join(dirname(dirname(bash)), "cmd", "git.exe");
		if (!existsSync(git)) return { kind: "present", version: null, path: dirname(dirname(bash)) };
		const found = await versionOf(git, env, platform);
		return found.kind === "present" ? { ...found, path: dirname(dirname(bash)) } : found;
	}
	// /usr/bin/git is a stub until the Command Line Tools exist; running it then
	// opens Apple's install dialog, so ask xcode-select before touching it.
	const git = findExecutable(["git"], pathEnv, platform, [], ["/usr/bin/git"]);
	if (git) return versionOf(git, env, platform);
	if (platform !== "darwin") return { kind: "missing" };
	try {
		await probe("/usr/bin/xcode-select", ["-p"], env, platform);
	} catch {
		return { kind: "missing" };
	}
	return versionOf("/usr/bin/git", env, platform);
}

async function detectNode(): Promise<SetupPresence> {
	resetReaRuntimeCache();
	const rea = await builtinReaState(true);
	if (rea.available) return { kind: "present", version: rea.nodeVersion ?? null, path: null };
	switch (rea.reason) {
		case "node-missing":
			return { kind: "missing" };
		case "node-version":
			return { kind: "outdated", version: rea.nodeVersion ?? "", minimum: REA_NODE_REQUIREMENT, path: null };
		default:
			return { kind: "broken", detail: rea.reason ?? "node-failed", path: null };
	}
}

/** Detect every setup item. `bunInstall` is where Bun's own installer puts it. */
export async function detectMachine(platform: SetupPlatform, bunInstall: string): Promise<Detection> {
	const pathEnv = await spawnPath();
	const env = { ...process.env, PATH: pathEnv };
	const win = platform === "win32";
	const bun = findExecutable([win ? "bun.exe" : "bun"], pathEnv, platform, [
		join(bunInstall, "bin", win ? "bun.exe" : "bun"),
	]);
	const brew = win
		? null
		: findExecutable(["brew"], pathEnv, platform, ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]);
	const winget = win
		? findExecutable(
				["winget.exe"],
				pathEnv,
				platform,
				process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe")] : [],
			)
		: null;
	// Homebrew's gh is the user's even when the login shell's PATH omits Homebrew's bin dir.
	const gh = findExecutable(
		[win ? "gh.exe" : "gh"],
		pathEnv,
		platform,
		win ? [] : brewBinDirs().map(dir => join(dir, "gh")),
	);
	const [bunPresence, omp, git, ghPresence, node] = await Promise.all([
		bun ? versionOf(bun, env, platform) : Promise.resolve<SetupPresence>({ kind: "missing" }),
		detectOmp(),
		detectGit(platform, pathEnv, env),
		gh ? versionOf(gh, env, platform) : Promise.resolve<SetupPresence>({ kind: "missing" }),
		detectNode(),
	]);
	return {
		presence: { bun: bunPresence, omp: omp.presence, git, gh: ghPresence, node },
		bun: bunPresence.kind === "present" ? bun : null,
		omp: omp.bin,
		brew,
		winget,
	};
}
