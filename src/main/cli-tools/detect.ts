/**
 * Where an installed vendor CLI lives and what owns it. The executable is found along the spawn PATH (the
 * login shell's, like every tool OMPdesk runs) and followed through its symlinks; the resolved path says
 * which package manager put it there — the same idea as `ompUpdateEnv` for omp: update a tool only through
 * the install that the user's own shell runs.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import type { CliSkipReason, CliToolId } from "../../shared/cli-update";
import { ompNeedsShell, ompSpawnArgs, ompSpawnCommand, parseOmpVersion } from "../omp-runtime";
import { findExecutable } from "../setup/detect";
import { brewBinDirs } from "../shell-env";
import { CLI_TOOL_SPECS, type CliToolSpec } from "./catalog";

export type CliPlatform = "darwin" | "win32";

/** Homebrew's `brew`: on PATH, else at its standard prefixes. Null on Windows and on a Mac without it. */
export function findBrew(pathEnv: string, platform: CliPlatform): string | null {
	return platform === "win32"
		? null
		: findExecutable(
				["brew"],
				pathEnv,
				platform,
				brewBinDirs().map(dir => join(dir, "brew")),
			);
}

/** Who owns an install: what `classifyInstall` read from the resolved path. */
export type CliOwner =
	| { method: "brew" | "brew-cask"; name: string; brew: string }
	| { method: "npm"; name: string; prefix: string; root: string }
	| { method: "bun"; name: string; bunRoot: string; root: string }
	| { method: "winget"; id: string }
	| { method: "managed"; item: "gh" | "node" }
	| { method: "self" };

export interface InstallContext {
	platform: CliPlatform;
	/** Machine setup's managed tools dir. */
	toolsDir: string;
	/** Homebrew's `brew`, when this Mac has it. */
	brew: string | null;
}

export type Classification = { owner: CliOwner; skip: null } | { owner: null; skip: CliSkipReason };

const SYSTEM_DIRS_MAC = [
	"/usr/bin/",
	"/bin/",
	"/usr/sbin/",
	"/sbin/",
	"/usr/libexec/",
	"/System/",
	"/Library/Developer/CommandLineTools/",
	"/Applications/Xcode",
];

/**
 * What owns the executable at `real` (symlinks already resolved). Pure: the path decides, read with forward
 * slashes on either platform. Homebrew's own kegs come first (a formula's libexec can hold a node_modules
 * tree), then a global Bun or npm package, then winget, then the tool's own updater; a system or app-bundled
 * copy is never OMPdesk's to update.
 */
export function classifyInstall(real: string, spec: CliToolSpec, ctx: InstallContext): Classification {
	const win = ctx.platform === "win32";
	const slash = (value: string) => value.replaceAll("\\", "/");
	const native = (value: string) => (win ? value.replaceAll("/", "\\") : value);
	const p = slash(real);
	const tools = `${slash(ctx.toolsDir).replace(/\/+$/, "")}/`;
	if (win ? p.toLowerCase().startsWith(tools.toLowerCase()) : p.startsWith(tools)) {
		return spec.managed
			? { owner: { method: "managed", item: spec.managed }, skip: null }
			: { owner: null, skip: "unknown-install" };
	}
	if (spec.managedOnly) return { owner: null, skip: "unknown-install" };
	if (win ? /^[a-z]:\/windows\//i.test(p) : SYSTEM_DIRS_MAC.some(dir => p.startsWith(dir))) {
		return { owner: null, skip: "system" };
	}
	const keg = win ? null : /\/Cellar\/([^/]+)\//.exec(p);
	const cask = win ? null : /\/Caskroom\/([^/]+)\//.exec(p);
	if (keg?.[1] || cask?.[1]) {
		if (!ctx.brew) return { owner: null, skip: "unknown-install" };
		const name = keg?.[1] ?? cask?.[1] ?? "";
		return { owner: { method: keg ? "brew" : "brew-cask", name, brew: ctx.brew }, skip: null };
	}
	if (win ? /\/WindowsApps\//i.test(p) : /\.app\/Contents\//.test(p)) return { owner: null, skip: "bundled" };
	const bun = /^(.*)\/install\/global\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
	const npm = win
		? /^(.*)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p)
		: /^(.*)\/lib\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
	// Claude Code's own updater handles its npm and Bun installs too; that is the vendor's way.
	if ((bun || npm) && spec.self) return { owner: { method: "self" }, skip: null };
	if (bun?.[1] && bun[2]) {
		const root = native(`${bun[1]}/install/global/node_modules/${bun[2]}`);
		return { owner: { method: "bun", name: bun[2], bunRoot: native(bun[1]), root }, skip: null };
	}
	if (npm?.[1] && npm[2]) {
		const root = native(win ? `${npm[1]}/node_modules/${npm[2]}` : `${npm[1]}/lib/node_modules/${npm[2]}`);
		return { owner: { method: "npm", name: npm[2], prefix: native(npm[1]), root }, skip: null };
	}
	if (win && spec.winget && /\/(WinGet\/(Packages|Links)|GitHub CLI)\//i.test(p)) {
		return { owner: { method: "winget", id: spec.winget }, skip: null };
	}
	if (spec.self) return { owner: { method: "self" }, skip: null };
	return { owner: null, skip: "unknown-install" };
}

/** The directory an update writes into: it must be the user's (no sudo, ever). */
export function writableTarget(owner: CliOwner, real: string, ctx: InstallContext): string {
	switch (owner.method) {
		case "brew":
		case "brew-cask":
			return dirname(dirname(owner.brew));
		case "npm":
		case "bun":
			return dirname(owner.root);
		case "managed":
			return ctx.toolsDir;
		case "winget":
			return dirname(real);
		case "self":
			return dirname(real);
	}
}

export interface CliDetection {
	id: CliToolId;
	/** As found on PATH. */
	path: string;
	/** Symlinks resolved. */
	real: string;
	owner: CliOwner | null;
	skip: CliSkipReason | null;
	installed: string | null;
}

export interface DetectDeps {
	pathEnv: string;
	env: NodeJS.ProcessEnv;
	ctx: InstallContext;
	/** `<bin> <args>` stdout, or throws (test seam). */
	probe?: (bin: string, args: string[]) => Promise<string>;
}

export function probeOutput(
	bin: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	platform: CliPlatform,
): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(
		ompSpawnCommand(bin, platform),
		ompSpawnArgs(bin, args, platform),
		{ env, shell: ompNeedsShell(bin, platform), timeout: 15_000, windowsHide: true },
		(error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)),
	);
	return promise;
}

/** The `version` a package dir's package.json records (npm and Bun global installs). */
export function packageVersion(root: string): string | null {
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const version =
			typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : null;
		return typeof version === "string" ? parseOmpVersion(version) : null;
	} catch {
		return null;
	}
}

/** `gh extension list`: the gh-copilot line's version (`v1.0.5`), or null when the extension is absent. */
export function ghCopilotVersion(list: string): string | null | undefined {
	const line = list.split(/\r?\n/).find(entry => /github\/gh-copilot\b/.test(entry));
	if (!line) return undefined;
	return parseOmpVersion(line);
}

/**
 * The file a Windows npm `.cmd` shim runs, or null for a file that names none. npm links a global bin on
 * POSIX, so its realpath is the package's own file; on Windows it writes a `.cmd` (npm's cmd-shim: the last
 * line runs `"%dp0%\node_modules\<package>\<bin>" %*`, older npm wrote `%~dp0\`), and only that text names
 * the package, relative to the shim's folder.
 */
export function cmdShimTarget(shim: string, text: string): string | null {
	const target = [...text.matchAll(/"%~?dp0%?\\([^"]+)"/g)].at(-1)?.[1];
	return target ? win32.join(win32.dirname(shim), target) : null;
}

/** Find and classify `id`; null when it is not installed (OMPdesk never installs a vendor CLI). */
export async function detectCliTool(id: CliToolId, deps: DetectDeps): Promise<CliDetection | null> {
	const spec = CLI_TOOL_SPECS[id];
	const { ctx } = deps;
	const win = ctx.platform === "win32";
	// Never the bare name on Windows: npm writes one beside its `.cmd` for POSIX shells, which Windows cannot start.
	const names = win ? [`${spec.bin}.exe`, `${spec.bin}.cmd`] : [spec.bin];
	// Homebrew's prefixes count even when the login shell's PATH omits them (the same lookup `resolveBin` makes).
	const path = findExecutable(
		names,
		deps.pathEnv,
		ctx.platform,
		win ? [] : brewBinDirs().flatMap(dir => names.map(name => join(dir, name))),
	);
	if (!path) return null;
	let real = path;
	try {
		real = realpathSync(path);
		if (win && /\.cmd$/i.test(real)) real = cmdShimTarget(real, readFileSync(real, "utf8")) ?? real;
	} catch {
		// A dangling link resolves to itself; classification then reads its own path.
	}
	const probe = deps.probe ?? ((bin: string, args: string[]) => probeOutput(bin, args, deps.env, ctx.platform));
	if (id === "gh-copilot") {
		// The extension lives in gh's own data dir, which is the user's; gh itself upgrades it.
		const version = ghCopilotVersion(await probe(path, ["extension", "list"]).catch(() => ""));
		if (version === undefined) return null;
		return { id, path, real, owner: { method: "self" }, skip: null, installed: version };
	}
	const classified = classifyInstall(real, spec, ctx);
	if (classified.skip === "unknown-install" && spec.managedOnly) return null;
	let skip = classified.skip;
	const owner = classified.owner;
	if (owner) {
		try {
			accessSync(writableTarget(owner, real, ctx), constants.W_OK);
		} catch {
			skip = "not-writable";
		}
	}
	const fromPackage = owner && (owner.method === "npm" || owner.method === "bun") ? packageVersion(owner.root) : null;
	const installed = fromPackage ?? (await probe(path, ["--version"]).then(parseOmpVersion, () => null));
	return { id, path, real, owner: skip ? null : owner, skip, installed };
}
