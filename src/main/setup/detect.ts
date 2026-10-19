/**
 * What this machine has: Bun, omp (through omp-runtime's own resolution and
 * version gate), Git, GitHub CLI and Node.js (through the built-in REA probe),
 * plus the package managers setup may use (Homebrew, winget).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { REA_NODE_REQUIREMENT } from "../../shared/builtin-mcp";
import type { GitShellProblem, SetupItemId, SetupPlatform, SetupPresence } from "../../shared/setup";
import { builtinReaState, resetReaRuntimeCache } from "../builtin-mcp";
import { parseOmpVersion, refreshSystemOmp, systemOmp } from "../omp-runtime";
import { writeRuntimeLog } from "../runtime-log";
import { brewBinDirs, spawnPath } from "../shell-env";
import { executableName, findOnPath, needsShell, spawnArgs, spawnCommand } from "../spawn";
import { execFileExecutor } from "../tailscale/cli";
import { locateTailscale, systemLocateDeps } from "../tailscale/locate";
import { findGitBash } from "./paths";

export interface Detection {
	presence: Record<SetupItemId, SetupPresence>;
	bun: string | null;
	omp: string | null;
	brew: string | null;
	winget: string | null;
}

/** `<bin> <args>` stdout (first line), or throws. */
function probe(bin: string, args: string[], env: NodeJS.ProcessEnv, platform: SetupPlatform): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const target = platform === "win32" ? "win32" : "darwin";
	execFile(
		spawnCommand(bin, target),
		spawnArgs(bin, args, target),
		{ env, shell: needsShell(bin, target), timeout: 15_000, windowsHide: true },
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

/**
 * The first detection of a launch shares the process-wide resolution the first tab, the stats server and
 * the stock helper use (one `omp --version` per launch; on Windows that is a cmd.exe and an omp boot).
 * Every later detection follows an install or an update, so it resolves again and refreshes that shared
 * result for them too. `MIN_OMP_VERSION` gates both the same way (`resolveOmp`).
 */
let launchResolutionUsed = false;

async function detectOmp(): Promise<{ presence: SetupPresence; bin: string | null }> {
	const resolution = await (launchResolutionUsed ? refreshSystemOmp() : systemOmp());
	launchResolutionUsed = true;
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
/** The sh probe's outcome as a problem, or null when sh started its child. 0xC0000142 is Mandatory ASLR's signature. */
export function gitShellProblem(result: { code: number | null; output: string }): GitShellProblem | null {
	if (result.code === 0) return null;
	if (/0xC0000142/i.test(result.output)) return { kind: "mandatory-aslr" };
	return { kind: "spawn-failed", detail: result.output.trim().split("\n").at(-1) || `exit ${result.code}` };
}

/**
 * Runs `<root>\usr\bin\sh.exe -c "/usr/bin/true; exit"`: two commands, so sh must fork a child as hooks and
 * editors do (a lone command is exec'd in place, and under Mandatory ASLR that fails silently with 127).
 */
export function probeGitShell(root: string, env: NodeJS.ProcessEnv): Promise<GitShellProblem | null> {
	const { promise, resolve } = Promise.withResolvers<GitShellProblem | null>();
	execFile(
		join(root, "usr", "bin", "sh.exe"),
		["-c", "/usr/bin/true; exit"],
		{ env, timeout: 30_000, windowsHide: true },
		(error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			resolve(gitShellProblem({ code, output: `${stdout}${stderr}` || (error?.message ?? "") }));
		},
	);
	return promise;
}

async function detectGit(platform: SetupPlatform, pathEnv: string, env: NodeJS.ProcessEnv): Promise<SetupPresence> {
	if (platform === "win32") {
		const bash = findGitBash({ ...env, PATH: pathEnv });
		if (!bash) return { kind: "missing" };
		const root = dirname(dirname(bash));
		const git = join(root, "cmd", "git.exe");
		const [found, gitShell] = await Promise.all([
			existsSync(git)
				? versionOf(git, env, platform)
				: Promise.resolve<SetupPresence>({ kind: "present", version: null, path: root }),
			existsSync(join(root, "usr", "bin", "sh.exe")) ? probeGitShell(root, env) : Promise.resolve(null),
		]);
		if (found.kind !== "present") return found;
		if (!gitShell) return { ...found, path: root };
		writeRuntimeLog({
			level: "warn",
			source: "setup",
			message: "Git's sh cannot start a child process",
			details: { root, ...gitShell },
		});
		return { ...found, path: root, gitShell };
	}
	// /usr/bin/git is a stub until the Command Line Tools exist; running it then
	// opens Apple's install dialog, so ask xcode-select before touching it.
	const git = findOnPath(["git"], pathEnv, platform, [], ["/usr/bin/git"]);
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
/**
 * Tailscale (Mobile web): installed when its CLI is found where Mobile web looks for it (tailscale/locate.ts). Whether
 * the daemon runs or is signed in is Mobile web's own state machine, never an install question, so a CLI that
 * does not answer `version` still counts as installed.
 */
export async function detectTailscale(platform: SetupPlatform, pathEnv: string): Promise<SetupPresence> {
	if (platform === "other") return { kind: "missing" };
	const located = await locateTailscale(
		systemLocateDeps(
			platform,
			null,
			async () => pathEnv,
			async () => null,
		),
	);
	if (!located) return { kind: "missing" };
	const result = await execFileExecutor(located.path, ["version"], { env: located.env, timeoutMs: 15_000 });
	const first = result.code === 0 ? (result.stdout.split(/\r?\n/)[0] ?? "") : "";
	return { kind: "present", version: /\d+\.\d+\.\d+/.exec(first)?.[0] ?? null, path: located.path };
}

/** Detect every setup item. `bunInstall` is where Bun's own installer puts it. */
export async function detectMachine(platform: SetupPlatform, bunInstall: string): Promise<Detection> {
	const pathEnv = await spawnPath();
	const env = { ...process.env, PATH: pathEnv };
	const win = platform === "win32";
	const bun = findOnPath([executableName("bun", platform)], pathEnv, platform, [
		join(bunInstall, "bin", executableName("bun", platform)),
	]);
	const brew = win ? null : findOnPath(["brew"], pathEnv, platform, ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]);
	const winget = win
		? findOnPath(
				["winget.exe"],
				pathEnv,
				platform,
				process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe")] : [],
			)
		: null;
	// Homebrew's gh is the user's even when the login shell's PATH omits Homebrew's bin dir.
	const gh = findOnPath(
		[executableName("gh", platform)],
		pathEnv,
		platform,
		win ? [] : brewBinDirs().map(dir => join(dir, "gh")),
	);
	const [bunPresence, omp, git, ghPresence, node, tailscale] = await Promise.all([
		bun ? versionOf(bun, env, platform) : Promise.resolve<SetupPresence>({ kind: "missing" }),
		detectOmp(),
		detectGit(platform, pathEnv, env),
		gh ? versionOf(gh, env, platform) : Promise.resolve<SetupPresence>({ kind: "missing" }),
		detectNode(),
		detectTailscale(platform, pathEnv),
	]);
	return {
		presence: { bun: bunPresence, omp: omp.presence, git, gh: ghPresence, node, tailscale },
		bun: bunPresence.kind === "present" ? bun : null,
		omp: omp.bin,
		brew,
		winget,
	};
}
