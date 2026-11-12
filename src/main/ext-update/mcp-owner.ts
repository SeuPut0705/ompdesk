/**
 * Who owns the binary an MCP server's `command` runs, found the way cli-tools finds a vendor CLI: along the
 * spawn PATH (the login shell's), through its symlinks, then by the path it resolves to. The owner is
 * classified by the SAME function as the vendor CLIs (`classifyInstall`, with a neutral spec: no vendor
 * updater, no managed copy), plus the three Python ecosystems that function does not know: pipx
 * (`…/pipx/venvs/<pkg>/…`), `uv tool` (`…/uv/tools/<pkg>/…`) and plain pip (a script whose shebang python has
 * an entry point of that name, asked through an injectable probe). A system, app-bundled or admin-owned copy
 * is left alone, with the cli-tools reason. Whether the file is a script or a native binary decides the
 * running rule (running.ts).
 *
 * What the file itself says (script or native, its shebang's python, a pipx or uv venv and the version its
 * dist-info records) is the core process's read (`native/ompdesk/crates/core/src/ext/binary.rs`). The PATH
 * lookup and the package managers' ownership stay here with cli-tools and spawn.ts, which machine setup and
 * the omp lookup call before the core can be counted on.
 */
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionSkipReason } from "../../shared/extension-update";
import {
	type CliPlatform,
	classifyInstall,
	cmdShimTarget,
	type InstallContext,
	packageVersion,
	writableTarget,
} from "../cli-tools/detect";
import type { PackageOwner } from "../cli-tools/plans";
import { parseOmpVersion } from "../omp-runtime";
import { brewBinDirs } from "../shell-env";
import { findOnPath, launcherNames } from "../spawn";
import { extRule } from "./core";

type VenvOwner = { method: "pipx"; name: string; venv: string } | { method: "uv"; name: string; dir: string };

export type McpOwner = PackageOwner | VenvOwner | { method: "pip"; name: string; python: string };

export type McpSkip = Extract<ExtensionSkipReason, "system" | "bundled" | "not-writable" | "unknown-install">;

export interface McpBinary {
	/** The `command` as configured. */
	command: string;
	/** Where it was found. */
	path: string;
	/** Symlinks resolved. */
	real: string;
	owner: McpOwner | null;
	skip: McpSkip | null;
	installed: string | null;
	/** A script (shebang, `.cmd`, `.js`) an interpreter loads lazily, as opposed to a native binary. */
	script: boolean;
}

export interface OwnerDeps {
	pathEnv: string;
	ctx: InstallContext;
	/** `<bin> <args>` stdout, or throws (python's `importlib.metadata`). */
	probe: (bin: string, args: string[]) => Promise<string>;
}

/** What the core reads of a resolved file (`ext.binaryFacts`). */
interface BinaryFacts {
	/** The command's name as a program (`C:\x\Tool.EXE` → `tool`). */
	name: string;
	/** Anything but a native binary: waiting is the safe side. */
	script: boolean;
	/** The pipx or `uv tool` venv the path names. */
	owner: VenvOwner | null;
	/** The version that venv's `<name>-<version>.dist-info` records. */
	installed: string | null;
	/** The python the file's shebang names, as written there. */
	python: string | null;
}

function binaryFacts(real: string, command: string, platform: CliPlatform): Promise<BinaryFacts> {
	return extRule("ext.binaryFacts", { real, command, platform });
}

/** Plain-file executable lookup: a path is used as it is, a bare name is looked up along PATH (and Homebrew's prefixes). */
export function resolveMcpCommand(command: string, pathEnv: string, ctx: InstallContext): string | null {
	if (/[\\/]/.test(command)) return existsSync(command) ? command : null;
	const win = ctx.platform === "win32";
	const names = win && /\.(exe|cmd)$/i.test(command) ? [command] : launcherNames(command, ctx.platform);
	return findOnPath(
		names,
		pathEnv,
		ctx.platform,
		win ? [] : brewBinDirs().flatMap(dir => names.map(name => join(dir, name))),
	);
}

type Ownership = { owner: McpOwner; skip: null } | { owner: null; skip: McpSkip };

/** The venv the core found, else the cli-tools classification, before the writable check. */
function ownership(facts: BinaryFacts, real: string, ctx: InstallContext): Ownership {
	if (facts.owner) return { owner: facts.owner, skip: null };
	// The spec claims no vendor updater and no managed copy, so `classifyInstall` only reads where the package manager put it.
	const classified = classifyInstall(real, { bin: facts.name, providers: [], lazyLoads: false }, ctx);
	if (!classified.owner) return { owner: null, skip: classified.skip };
	const owner = classified.owner;
	if (owner.method === "self" || owner.method === "managed") return { owner: null, skip: "unknown-install" };
	return { owner, skip: null };
}

/** The owner a resolved path names (pipx, uv tool, then the cli-tools classification), before the writable check. */
export async function classifyMcpBinary(real: string, command: string, ctx: InstallContext): Promise<Ownership> {
	return ownership(await binaryFacts(real, command, ctx.platform), real, ctx);
}

function writableDir(owner: McpOwner, real: string, ctx: InstallContext): string {
	switch (owner.method) {
		case "pipx":
			return owner.venv;
		case "uv":
			return owner.dir;
		case "pip":
			return dirname(real);
		default:
			return writableTarget(owner, real, ctx);
	}
}

const DIST_SNIPPET = [
	"import sys, importlib.metadata as m",
	"for d in m.distributions():",
	" for e in (d.entry_points or ()):",
	"  if e.group == 'console_scripts' and e.name == sys.argv[1]:",
	"   print(d.metadata['Name']); raise SystemExit(0)",
	"raise SystemExit(1)",
].join("\n");

const VERSION_SNIPPET = "import sys, importlib.metadata as m; print(m.version(sys.argv[1]))";

async function installedVersion(
	owner: McpOwner,
	real: string,
	facts: BinaryFacts,
	deps: OwnerDeps,
): Promise<string | null> {
	switch (owner.method) {
		case "npm":
		case "bun":
			return packageVersion(owner.root);
		case "brew":
		case "brew-cask": {
			const dir = /\/(?:Cellar|Caskroom)\/[^/]+\/([^/]+)\//.exec(real.replaceAll("\\", "/"))?.[1];
			return dir ? parseOmpVersion(dir) : null;
		}
		case "pipx":
		case "uv":
			return facts.installed;
		case "pip":
			return deps.probe(owner.python, ["-c", VERSION_SNIPPET, owner.name]).then(
				output => output.trim() || null,
				() => null,
			);
		case "winget":
			return null;
	}
}

/** Find `command`, follow its links, own it. Null when nothing on PATH (or at that path) runs. */
export async function detectMcpBinary(command: string, deps: OwnerDeps): Promise<McpBinary | null> {
	const { ctx } = deps;
	const path = resolveMcpCommand(command, deps.pathEnv, ctx);
	if (!path) return null;
	let real = path;
	try {
		real = realpathSync(path);
		if (ctx.platform === "win32" && /\.cmd$/i.test(real))
			real = cmdShimTarget(real, readFileSync(real, "utf8")) ?? real;
	} catch {
		// A dangling link resolves to itself; classification then reads its own path.
	}
	const facts = await binaryFacts(real, command, ctx.platform);
	const classified = ownership(facts, real, ctx);
	let owner: McpOwner | null = classified.owner;
	let skip: McpSkip | null = classified.skip;
	if (!owner && skip === "unknown-install" && facts.script && facts.python) {
		// `#!/usr/bin/env python3` is looked up along PATH.
		const python = /[\\/]/.test(facts.python) ? facts.python : findOnPath([facts.python], deps.pathEnv, ctx.platform);
		const dist = python
			? await deps.probe(python, ["-c", DIST_SNIPPET, facts.name]).then(
					output => output.trim(),
					() => "",
				)
			: "";
		if (python && dist) {
			owner = { method: "pip", name: dist, python };
			skip = null;
		}
	}
	const claimed = owner;
	if (owner) {
		try {
			accessSync(writableDir(owner, real, ctx), constants.W_OK);
		} catch {
			owner = null;
			skip = "not-writable";
		}
	}
	const installed = claimed ? await installedVersion(claimed, real, facts, deps) : null;
	return { command, path, real, owner, skip, installed, script: facts.script };
}
