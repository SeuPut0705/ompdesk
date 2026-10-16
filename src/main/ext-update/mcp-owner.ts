/**
 * Who owns the binary an MCP server's `command` runs, found the way cli-tools finds a vendor CLI: along the
 * spawn PATH (the login shell's), through its symlinks, then by the path it resolves to. The owner is
 * classified by the SAME function as the vendor CLIs (`classifyInstall`, with a neutral spec: no vendor
 * updater, no managed copy), plus the three Python ecosystems that function does not know: pipx
 * (`…/pipx/venvs/<pkg>/…`), `uv tool` (`…/uv/tools/<pkg>/…`) and plain pip (a script whose shebang python has
 * an entry point of that name, asked through an injectable probe). A system, app-bundled or admin-owned copy
 * is left alone, with the cli-tools reason. Whether the file is a script or a native binary decides the
 * running rule (running.ts).
 */
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionSkipReason } from "../../shared/extension-update";
import type { CliToolSpec } from "../cli-tools/catalog";
import {
	classifyInstall,
	cmdShimTarget,
	type InstallContext,
	packageVersion,
	writableTarget,
} from "../cli-tools/detect";
import type { PackageOwner } from "../cli-tools/plans";
import { parseOmpVersion } from "../omp-runtime";
import { findExecutable } from "../setup/detect";
import { brewBinDirs } from "../shell-env";
import { commandName } from "./mcp";

export type McpOwner =
	| PackageOwner
	| { method: "pipx"; name: string; venv: string }
	| { method: "uv"; name: string; dir: string }
	| { method: "pip"; name: string; python: string };

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

const slash = (value: string) => value.replaceAll("\\", "/");

/** Plain-file executable lookup: a path is used as it is, a bare name is looked up along PATH (and Homebrew's prefixes). */
export function resolveMcpCommand(command: string, pathEnv: string, ctx: InstallContext): string | null {
	if (/[\\/]/.test(command)) return existsSync(command) ? command : null;
	const win = ctx.platform === "win32";
	const names = win ? (/\.(exe|cmd)$/i.test(command) ? [command] : [`${command}.exe`, `${command}.cmd`]) : [command];
	return findExecutable(
		names,
		pathEnv,
		ctx.platform,
		win ? [] : brewBinDirs().flatMap(dir => names.map(name => join(dir, name))),
	);
}

/** Claims no vendor updater and no managed copy, so `classifyInstall` only reads where the package manager put it. */
function neutralSpec(command: string): CliToolSpec {
	return { bin: commandName(command), providers: [], lazyLoads: false };
}

/** Pure: the owner a resolved path names (pipx, uv tool, then the cli-tools classification), before the writable check. */
export function classifyMcpBinary(
	real: string,
	command: string,
	ctx: InstallContext,
): { owner: McpOwner; skip: null } | { owner: null; skip: McpSkip } {
	const win = ctx.platform === "win32";
	const native = (value: string) => (win ? value.replaceAll("/", "\\") : value);
	const p = slash(real);
	const pipx = /^(.*\/pipx\/venvs\/([^/]+))\//i.exec(p);
	if (pipx?.[1] && pipx[2]) return { owner: { method: "pipx", name: pipx[2], venv: native(pipx[1]) }, skip: null };
	const uv = /^(.*\/uv\/tools\/([^/]+))\//i.exec(p);
	if (uv?.[1] && uv[2]) return { owner: { method: "uv", name: uv[2], dir: native(uv[1]) }, skip: null };
	const classified = classifyInstall(real, neutralSpec(command), ctx);
	if (classified.owner) {
		// The neutral spec has no vendor updater or managed copy, so only the package managers come back.
		const owner = classified.owner;
		if (owner.method === "self" || owner.method === "managed") return { owner: null, skip: "unknown-install" };
		return { owner, skip: null };
	}
	return { owner: null, skip: classified.skip };
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

export type FileKind = "script" | "native" | "unknown";

/** Shebang or a script extension: script; Mach-O, ELF or PE magic: native; anything else: unknown. */
export function fileKind(path: string): FileKind {
	if (/\.(cmd|bat|ps1|js|mjs|cjs|py)$/i.test(path)) return "script";
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const head = Buffer.alloc(4);
		const read = readSync(fd, head, 0, 4, 0);
		if (read >= 2 && head[0] === 0x23 && head[1] === 0x21) return "script";
		if (read >= 2 && head[0] === 0x4d && head[1] === 0x5a) return "native";
		if (read >= 4) {
			const magic = head.readUInt32BE(0);
			// ELF, Mach-O 32/64 in both byte orders, and the universal (fat) header.
			if ([0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return "native";
		}
		return "unknown";
	} catch {
		return "unknown";
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** Unknown counts as a script: waiting is the safe side. */
export const isScriptFile = (path: string): boolean => fileKind(path) !== "native";

function firstLine(path: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(256);
		const read = readSync(fd, buffer, 0, 256, 0);
		const text = buffer.subarray(0, read).toString("utf8");
		return text.startsWith("#!") ? (text.split(/\r?\n/)[0] ?? null) : null;
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** The python a shebang line names (`#!/usr/bin/env python3` is looked up along PATH); null for any other interpreter. */
export function shebangPython(line: string, pathEnv: string, ctx: InstallContext): string | null {
	const tokens = line.slice(2).trim().split(/\s+/);
	let program = tokens[0] ?? "";
	if (/(^|\/)env$/.test(program))
		program = tokens.slice(1).find(token => !token.startsWith("-") && !token.includes("=")) ?? "";
	if (!/^python[\d.]*$/.test(commandName(program))) return null;
	return /[\\/]/.test(program) ? program : findExecutable([program], pathEnv, ctx.platform);
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

const normalizeDist = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The version a venv's `<name>-<version>.dist-info` records (pipx and uv tool venvs). */
export function distInfoVersion(venv: string, name: string, platform: InstallContext["platform"]): string | null {
	try {
		const libs =
			platform === "win32"
				? [join(venv, "Lib", "site-packages")]
				: readdirSync(join(venv, "lib"))
						.filter(entry => entry.startsWith("python"))
						.map(entry => join(venv, "lib", entry, "site-packages"));
		const wanted = normalizeDist(name);
		for (const lib of libs) {
			for (const entry of readdirSync(lib)) {
				const match = /^(.+?)-(\d[^-]*)\.dist-info$/.exec(entry);
				if (match?.[1] && match[2] && normalizeDist(match[1]) === wanted) return match[2];
			}
		}
	} catch {
		// No readable venv: the version is unknown.
	}
	return null;
}

async function installedVersion(owner: McpOwner, real: string, deps: OwnerDeps): Promise<string | null> {
	switch (owner.method) {
		case "npm":
		case "bun":
			return packageVersion(owner.root);
		case "brew":
		case "brew-cask": {
			const dir = /\/(?:Cellar|Caskroom)\/[^/]+\/([^/]+)\//.exec(slash(real))?.[1];
			return dir ? parseOmpVersion(dir) : null;
		}
		case "pipx":
			return distInfoVersion(owner.venv, owner.name, deps.ctx.platform);
		case "uv":
			return distInfoVersion(owner.dir, owner.name, deps.ctx.platform);
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
	const script = isScriptFile(real);
	const classified = classifyMcpBinary(real, command, ctx);
	let owner: McpOwner | null = classified.owner;
	let skip: McpSkip | null = classified.skip;
	if (!owner && skip === "unknown-install" && script) {
		const line = firstLine(real);
		const python = line ? shebangPython(line, deps.pathEnv, ctx) : null;
		const dist = python
			? await deps.probe(python, ["-c", DIST_SNIPPET, commandName(command)]).then(
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
	const installed = claimed ? await installedVersion(claimed, real, deps) : null;
	return { command, path, real, owner, skip, installed, script };
}
