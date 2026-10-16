/**
 * The check and update commands for an MCP server's package: its binary's owner (npm, Bun, Homebrew,
 * winget through cli-tools' own `ownerCheckCommand`/`ownerUpdateCommand`; pipx, `uv tool` and pip here), and
 * the registry lookup for a pinned runner package (`npx pkg@1.2.3`). Every command asks the owner or the
 * user's own configured registry/index, so a private registry or `pip.conf` is honored; the update runs that
 * owner's own command for the install it found, never with sudo. Commands are fixed here; nothing comes
 * from the renderer or from the MCP config except the package name.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	bunView,
	type CliCommand,
	command,
	NPM_BIN,
	ownerCheckCommand,
	ownerUpdateCommand,
	type PlanTools,
	parseLatest,
} from "../cli-tools/plans";
import { findExecutable } from "../setup/detect";
import type { McpClass } from "./mcp";
import type { McpOwner } from "./mcp-owner";

export type RunnerPackage = Extract<McpClass, { kind: "runner" }>;

const win = (tools: PlanTools) => tools.platform === "win32";

const pipIndex = (python: string, name: string): CliCommand =>
	command(python, ["-m", "pip", "index", "versions", name]);

/**
 * The read-only check that prints the newest version. Null when only the owner's own idempotent upgrade can
 * tell (`uv tool upgrade`), so the updater runs it and compares the installed version before and after.
 */
export function mcpOwnerCheck(owner: McpOwner, tools: PlanTools): CliCommand | null {
	switch (owner.method) {
		case "pipx": {
			// A pipx venv carries its own pip; `pip index versions` reads the user's index configuration.
			const python = join(owner.venv, win(tools) ? "Scripts" : "bin", win(tools) ? "python.exe" : "python");
			return existsSync(python) ? pipIndex(python, owner.name) : null;
		}
		case "uv":
			return null;
		case "pip":
			return pipIndex(owner.python, owner.name);
		default:
			return ownerCheckCommand(owner, tools);
	}
}

/** The update of the install the binary came from. */
export function mcpOwnerUpdate(owner: McpOwner, latest: string | null, tools: PlanTools): CliCommand | null {
	switch (owner.method) {
		case "pipx": {
			const pipx = findExecutable([win(tools) ? "pipx.exe" : "pipx"], tools.pathEnv, tools.platform);
			return pipx ? command(pipx, ["upgrade", owner.name]) : null;
		}
		case "uv": {
			const uv = findExecutable([win(tools) ? "uv.exe" : "uv"], tools.pathEnv, tools.platform);
			return uv ? command(uv, ["tool", "upgrade", owner.name]) : null;
		}
		case "pip":
			return command(owner.python, ["-m", "pip", "install", "--upgrade", owner.name]);
		default:
			return ownerUpdateCommand(owner, latest, tools);
	}
}

/**
 * The registry lookup for a pinned runner package: npm's `npm view` (Bun's `bun pm view` for `bunx`/`bun x`,
 * each falling back to the other), PyPI's through the first python's `pip index versions`. Null when no
 * tool to ask is installed, or the spec is a URL or path: the row then stays pinned with no latest.
 */
export function runnerCheck(runner: RunnerPackage, tools: PlanTools): CliCommand | null {
	if (!runner.checkable) return null;
	if (runner.ecosystem === "pypi") {
		const python = findExecutable(win(tools) ? ["python.exe"] : ["python3", "python"], tools.pathEnv, tools.platform);
		return python ? pipIndex(python, runner.pkg) : null;
	}
	const npm = findExecutable([NPM_BIN[tools.platform]], tools.pathEnv, tools.platform);
	const bun = findExecutable([win(tools) ? "bun.exe" : "bun"], tools.pathEnv, tools.platform);
	const viaNpm = npm ? command(npm, ["view", runner.pkg, "version"]) : null;
	const viaBun = bun ? bunView(bun, runner.pkg) : null;
	return runner.runner === "bunx" || runner.runner === "bun-x" ? (viaBun ?? viaNpm) : (viaNpm ?? viaBun);
}

/** `pip index versions` output: `name (1.2.3)` on the first line, `Available versions: 1.2.3, 1.2.2, …` below. */
export function parsePipIndex(output: string): string {
	const newest =
		/^\S+ \(([^)\s]+)\)/m.exec(output)?.[1] ?? /Available versions:\s*([^,\s]+)/.exec(output)?.[1] ?? null;
	if (!newest) throw new Error(output.trim().split(/\r?\n/).at(-1) || "no version in pip's answer");
	return newest;
}

/** `npm view <pkg> version`: the version with its prerelease tag, from the first line that has one. */
export function parseRegistryVersion(output: string): string {
	const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0];
	if (!version) throw new Error(output.trim().split(/\r?\n/).at(-1) || "no version in the registry's answer");
	return version;
}

/** The newest version in an owner check's output (cli-tools' parser for the package managers it knows). */
export function parseMcpOwnerLatest(owner: McpOwner, output: string, installed: string | null): string {
	switch (owner.method) {
		case "pipx":
		case "pip":
			return parsePipIndex(output);
		case "uv":
			throw new Error("uv has no read-only check");
		default:
			return parseLatest(owner, output, installed);
	}
}

/** The newest version in a runner package's registry lookup. */
export function parseRunnerLatest(runner: RunnerPackage, output: string): string {
	return runner.ecosystem === "pypi" ? parsePipIndex(output) : parseRegistryVersion(output);
}
