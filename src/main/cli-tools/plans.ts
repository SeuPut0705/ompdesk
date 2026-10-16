/**
 * How each owner checks for and installs a newer version of a vendor CLI. The check asks the owner itself
 * (`npm view`, `bun pm view`, `brew outdated`, `winget list --upgrade-available`, the managed archive's
 * release feed), so it follows the user's registry and taps; the update runs that owner's own command for
 * the same prefix the tool was found in, never with sudo. Commands are fixed here; nothing comes from the
 * renderer.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseOmpVersion } from "../omp-runtime";
import type { SpawnSpec } from "../setup/plans";
import { executableName, findOnPath, needsShell, spawnArgs, spawnCommand } from "../spawn";
import { CLI_TOOL_SPECS } from "./catalog";
import type { CliDetection, CliOwner, CliPlatform } from "./detect";

/** A process to run: the check (read-only, short) or the update (under the setup supervisor). */
export interface CliCommand {
	spawn: SpawnSpec;
	/** Added to the installer environment. */
	env: Record<string, string>;
	/**
	 * Run in a private temp dir holding an empty `package.json`: `bun pm view` refuses to run without one in its
	 * cwd ("No package.json was found", Bun 1.4.2), and the check must not depend on where main happens to run.
	 */
	packageDir?: true;
}

export interface PlanTools {
	platform: CliPlatform;
	pathEnv: string;
}

/** A Windows `.cmd` shim (npm's) runs through cmd.exe, quoted the way omp's own shim is. */
export function command(file: string, args: string[], env: Record<string, string> = {}): CliCommand {
	const platform = needsShell(file, "win32") ? "win32" : "darwin";
	return {
		spawn: {
			file: spawnCommand(file, platform),
			args: spawnArgs(file, args, platform),
			shell: needsShell(file, platform),
		},
		env,
	};
}

/** npm's Windows launcher is `npm.cmd`; the bare `npm` beside it is a POSIX shell script Windows cannot start. */
export const NPM_BIN = { win32: "npm.cmd", darwin: "npm" } as const;

/** The npm that owns `prefix` (its own, else the first on PATH, always aimed at that prefix). */
function npmFor(prefix: string, tools: PlanTools): string | null {
	const own = tools.platform === "win32" ? join(prefix, "npm.cmd") : join(prefix, "bin", "npm");
	return existsSync(own) ? own : findOnPath([NPM_BIN[tools.platform]], tools.pathEnv, tools.platform);
}

function bunFor(bunRoot: string, tools: PlanTools): string | null {
	const own = join(bunRoot, "bin", executableName("bun", tools.platform));
	return existsSync(own) ? own : findOnPath([executableName("bun", tools.platform)], tools.pathEnv, tools.platform);
}

function winget(tools: PlanTools): string | null {
	return findOnPath(["winget.exe"], tools.pathEnv, tools.platform);
}

/** `bun pm view <name> version`, the newest version on the registry Bun is configured with. */
export function bunView(bun: string, name: string, env: Record<string, string> = {}): CliCommand {
	return { ...command(bun, ["pm", "view", name, "version"], env), packageDir: true };
}

/**
 * The read-only check that prints the newest version, or null when only the tool's own updater can tell
 * (cursor-agent, gh-copilot) or the owner is machine setup's archive (checked through its release feed).
 */
export function checkCommand(detection: CliDetection, owner: CliOwner, tools: PlanTools): CliCommand | null {
	switch (owner.method) {
		case "self": {
			const spec = CLI_TOOL_SPECS[detection.id];
			if (spec.self?.checks !== "registry" || !spec.npm) return null;
			const npm = findOnPath([NPM_BIN[tools.platform]], tools.pathEnv, tools.platform);
			if (npm) return command(npm, ["view", spec.npm, "version"]);
			const bun = findOnPath([executableName("bun", tools.platform)], tools.pathEnv, tools.platform);
			return bun ? bunView(bun, spec.npm) : null;
		}
		case "managed":
			return null;
		default:
			return ownerCheckCommand(owner, tools);
	}
}

/** The owners that are a package manager's own install (shared with the MCP servers' binaries, ext-update/mcp-plans.ts). */
export type PackageOwner = Extract<CliOwner, { method: "brew" | "brew-cask" | "npm" | "bun" | "winget" }>;

/** The read-only check of a package manager's install; the one implementation both updaters use. */
export function ownerCheckCommand(owner: PackageOwner, tools: PlanTools): CliCommand | null {
	switch (owner.method) {
		case "npm": {
			const npm = npmFor(owner.prefix, tools);
			return npm ? command(npm, ["view", owner.name, "version"]) : null;
		}
		case "bun": {
			const bun = bunFor(owner.bunRoot, tools);
			return bun ? bunView(bun, owner.name, { BUN_INSTALL: owner.bunRoot }) : null;
		}
		case "brew":
			return command(owner.brew, ["outdated", "--json=v2", owner.name]);
		case "brew-cask":
			return command(owner.brew, ["outdated", "--json=v2", "--cask", owner.name]);
		case "winget": {
			const bin = winget(tools);
			return bin
				? command(bin, [
						"list",
						"--id",
						owner.id,
						"-e",
						"--upgrade-available",
						"--accept-source-agreements",
						"--disable-interactivity",
					])
				: null;
		}
	}
}

/**
 * The newest version in a check's output; `installed` when the owner lists nothing newer (Homebrew and
 * winget list only what is outdated). Throws when the output says nothing usable.
 */
export function parseLatest(owner: CliOwner, output: string, installed: string | null): string {
	switch (owner.method) {
		case "brew":
		case "brew-cask": {
			const parsed: unknown = JSON.parse(output);
			const key = owner.method === "brew" ? "formulae" : "casks";
			const list =
				typeof parsed === "object" && parsed !== null && key in parsed
					? (parsed as Record<string, unknown>)[key]
					: null;
			const entry = Array.isArray(list)
				? list.find(
						(item: unknown) =>
							typeof item === "object" && item !== null && "name" in item && item.name === owner.name,
					)
				: undefined;
			const current =
				entry && typeof entry === "object" && "current_version" in entry ? entry.current_version : undefined;
			const latest = typeof current === "string" ? parseOmpVersion(current) : installed;
			if (!latest) throw new Error(`brew outdated said nothing about ${owner.name}`);
			return latest;
		}
		case "winget": {
			const line = output.split(/\r?\n/).find(entry => entry.includes(owner.id));
			const versions = line?.match(/\d+\.\d+\.\d+/g) ?? [];
			const latest = versions.at(-1) ?? installed;
			if (!latest) throw new Error(`winget said nothing about ${owner.id}`);
			return latest;
		}
		default: {
			const latest = parseOmpVersion(output);
			if (!latest) throw new Error(output.trim().split(/\r?\n/).at(-1) || "no version in the registry's answer");
			return latest;
		}
	}
}

/** The update itself, for every owner but machine setup's archive (SetupService runs that one). */
export function updateCommand(
	detection: CliDetection,
	owner: Exclude<CliOwner, { method: "managed" }>,
	latest: string | null,
	tools: PlanTools,
): CliCommand | null {
	if (owner.method === "self") {
		const spec = CLI_TOOL_SPECS[detection.id];
		return spec.self ? command(detection.path, [...spec.self.args]) : null;
	}
	return ownerUpdateCommand(owner, latest, tools);
}

/** A package manager's own update of the install it owns (`latest` pins npm/Bun to it; null means `@latest`). */
export function ownerUpdateCommand(owner: PackageOwner, latest: string | null, tools: PlanTools): CliCommand | null {
	const target = (name: string) => (latest ? `${name}@${latest}` : `${name}@latest`);
	switch (owner.method) {
		case "npm": {
			const npm = npmFor(owner.prefix, tools);
			return npm ? command(npm, ["install", "-g", "--prefix", owner.prefix, target(owner.name)]) : null;
		}
		case "bun": {
			const bun = bunFor(owner.bunRoot, tools);
			return bun ? command(bun, ["install", "-g", target(owner.name)], { BUN_INSTALL: owner.bunRoot }) : null;
		}
		case "brew":
			return command(owner.brew, ["upgrade", owner.name], { HOMEBREW_NO_AUTO_UPDATE: "1" });
		case "brew-cask":
			return command(owner.brew, ["upgrade", "--cask", owner.name], { HOMEBREW_NO_AUTO_UPDATE: "1" });
		case "winget": {
			const bin = winget(tools);
			return bin
				? command(bin, [
						"upgrade",
						"--id",
						owner.id,
						"-e",
						"--accept-source-agreements",
						"--accept-package-agreements",
						"--disable-interactivity",
					])
				: null;
		}
	}
}

/**
 * Whether an update must wait while a process of the tool runs: npm and Bun replace the whole package dir
 * (measured: a new directory inode, files only the old version had are gone, a later `require` reads the
 * new version's file) and Homebrew removes the old keg, so a running Node CLI could load a file of the other
 * version or find it missing. A single native binary keeps running from its old inode, and the vendors'
 * own updaters install into a new versioned dir and switch a link.
 */
export function waitsForIdle(detection: CliDetection, owner: CliOwner): boolean {
	if (owner.method === "npm" || owner.method === "bun") return true;
	if (owner.method === "brew" || owner.method === "brew-cask") return CLI_TOOL_SPECS[detection.id].lazyLoads;
	return false;
}

/** `ps` command lines: is a process of this tool running (its executable, its package dir, or its name)? */
export function runningIn(commands: string, detection: CliDetection, owner: CliOwner): boolean {
	const bin = CLI_TOOL_SPECS[detection.id].bin;
	const dirs = [detection.real, detection.path];
	if (owner.method === "npm" || owner.method === "bun") dirs.push(owner.root);
	const keg =
		owner.method === "brew" || owner.method === "brew-cask"
			? `/${owner.method === "brew" ? "Cellar" : "Caskroom"}/${owner.name}/`
			: null;
	return commands.split("\n").some(line => {
		const text = line.trim();
		if (!text) return false;
		const first = text.split(/\s+/)[0] ?? "";
		return (
			first === bin ||
			first.endsWith(`/${bin}`) ||
			dirs.some(dir => text.includes(dir)) ||
			(keg !== null && text.includes(keg))
		);
	});
}
