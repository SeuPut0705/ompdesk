import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCommand, ownerCheckCommand, ownerUpdateCommand, updateCommand } from "../cli-tools/plans";
import type { McpOwner } from "./mcp-owner";
import {
	mcpOwnerCheck,
	mcpOwnerUpdate,
	parseMcpOwnerLatest,
	parsePipIndex,
	parseRegistryVersion,
	parseRunnerLatest,
	type RunnerPackage,
	runnerCheck,
} from "./mcp-plans";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A PATH dir holding empty executables named `names`. */
function pathWith(...names: string[]): { pathEnv: string; platform: "darwin"; root: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-mcp-plans-"));
	dirs.push(root);
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	for (const name of names) fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 });
	return { pathEnv: bin, platform: "darwin", root };
}

const argv = (command: { spawn: { file: string; args: string[] } } | null) =>
	command ? [path.basename(command.spawn.file), ...command.spawn.args] : null;

describe("owner commands", () => {
	it("npm, Bun and Homebrew are cli-tools' own commands", () => {
		const tools = pathWith("npm", "bun");
		const npm: McpOwner = {
			method: "npm",
			name: "@s/pkg",
			prefix: "/nowhere",
			root: "/nowhere/lib/node_modules/@s/pkg",
		};
		expect(argv(mcpOwnerCheck(npm, tools))).toEqual(["npm", "view", "@s/pkg", "version"]);
		expect(argv(mcpOwnerUpdate(npm, "1.2.3", tools))).toEqual([
			"npm",
			"install",
			"-g",
			"--prefix",
			"/nowhere",
			"@s/pkg@1.2.3",
		]);
		const bun: McpOwner = { method: "bun", name: "pkg", bunRoot: "/nowhere/.bun", root: "/nowhere/.bun/x" };
		const check = mcpOwnerCheck(bun, tools);
		expect(argv(check)).toEqual(["bun", "pm", "view", "pkg", "version"]);
		expect(check?.packageDir).toBe(true);
		expect(check?.env).toEqual({ BUN_INSTALL: "/nowhere/.bun" });
		expect(argv(mcpOwnerUpdate(bun, null, tools))).toEqual(["bun", "install", "-g", "pkg@latest"]);
		const brew: McpOwner = { method: "brew", name: "thing", brew: "/opt/homebrew/bin/brew" };
		expect(argv(mcpOwnerCheck(brew, tools))).toEqual(["brew", "outdated", "--json=v2", "thing"]);
		expect(mcpOwnerUpdate(brew, null, tools)).toMatchObject({ env: { HOMEBREW_NO_AUTO_UPDATE: "1" } });
	});

	it("the cli-tools functions delegate to the same implementation", () => {
		const tools = pathWith("npm");
		const owner = {
			method: "npm",
			name: "@openai/codex",
			prefix: "/p",
			root: "/p/lib/node_modules/@openai/codex",
		} as const;
		const detection = {
			id: "codex",
			path: "/p/bin/codex",
			real: "/p/lib/x",
			owner,
			skip: null,
			installed: "1.0.0",
		} as const;
		expect(checkCommand(detection, owner, tools)).toEqual(ownerCheckCommand(owner, tools));
		expect(updateCommand(detection, owner, "2.0.0", tools)).toEqual(ownerUpdateCommand(owner, "2.0.0", tools));
	});

	it("pipx checks through its venv's pip when it has one, and upgrades through pipx", () => {
		const tools = pathWith("pipx");
		const venv = path.join(tools.root, "pipx", "venvs", "mcp-thing");
		fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
		const owner: McpOwner = { method: "pipx", name: "mcp-thing", venv };
		expect(mcpOwnerCheck(owner, tools)).toBeNull();
		fs.writeFileSync(path.join(venv, "bin", "python"), "", { mode: 0o755 });
		expect(argv(mcpOwnerCheck(owner, tools))).toEqual(["python", "-m", "pip", "index", "versions", "mcp-thing"]);
		expect(argv(mcpOwnerUpdate(owner, null, tools))).toEqual(["pipx", "upgrade", "mcp-thing"]);
		expect(mcpOwnerUpdate(owner, null, { ...tools, pathEnv: "/nowhere" })).toBeNull();
	});

	it("uv has no read-only check and upgrades through uv tool", () => {
		const tools = pathWith("uv");
		const owner: McpOwner = { method: "uv", name: "mcp-thing", dir: "/x/uv/tools/mcp-thing" };
		expect(mcpOwnerCheck(owner, tools)).toBeNull();
		expect(argv(mcpOwnerUpdate(owner, null, tools))).toEqual(["uv", "tool", "upgrade", "mcp-thing"]);
	});

	it("pip asks and upgrades through the python its script names", () => {
		const tools = pathWith();
		const owner: McpOwner = { method: "pip", name: "my-dist", python: "/opt/py/bin/python3" };
		expect(mcpOwnerCheck(owner, tools)?.spawn).toMatchObject({
			file: "/opt/py/bin/python3",
			args: ["-m", "pip", "index", "versions", "my-dist"],
		});
		expect(mcpOwnerUpdate(owner, null, tools)?.spawn.args).toEqual(["-m", "pip", "install", "--upgrade", "my-dist"]);
	});
});

describe("pinned runner packages", () => {
	const npm = (over: Partial<RunnerPackage> = {}): RunnerPackage => ({
		kind: "runner",
		runner: "npx",
		ecosystem: "npm",
		pkg: "@s/server",
		version: "1.2.3",
		spec: "@s/server@1.2.3",
		pinned: true,
		checkable: true,
		...over,
	});

	it("npx-family packages ask npm view, bunx asks Bun first, each falling back to the other", () => {
		const both = pathWith("npm", "bun");
		expect(argv(runnerCheck(npm(), both))).toEqual(["npm", "view", "@s/server", "version"]);
		expect(argv(runnerCheck(npm({ runner: "bunx" }), both))).toEqual(["bun", "pm", "view", "@s/server", "version"]);
		expect(runnerCheck(npm({ runner: "bunx" }), both)?.packageDir).toBe(true);
		expect(argv(runnerCheck(npm(), pathWith("bun")))).toEqual(["bun", "pm", "view", "@s/server", "version"]);
		expect(argv(runnerCheck(npm({ runner: "bun-x" }), pathWith("npm")))).toEqual([
			"npm",
			"view",
			"@s/server",
			"version",
		]);
		expect(runnerCheck(npm(), pathWith())).toBeNull();
	});

	it("uvx and pipx run packages ask pip through the first python", () => {
		const tools = pathWith("python3");
		const pypi = npm({
			runner: "uvx",
			ecosystem: "pypi",
			pkg: "mcp-server-git",
			version: "1.2.3",
			spec: "mcp-server-git==1.2.3",
		});
		expect(argv(runnerCheck(pypi, tools))).toEqual(["python3", "-m", "pip", "index", "versions", "mcp-server-git"]);
		expect(runnerCheck(pypi, pathWith())).toBeNull();
	});

	it("a git URL or path has nothing to ask", () => {
		expect(runnerCheck(npm({ checkable: false }), pathWith("npm"))).toBeNull();
	});
});

describe("parsers", () => {
	it("pip index versions", () => {
		expect(
			parsePipIndex("mcp-thing (1.4.0)\nAvailable versions: 1.4.0, 1.3.0\n  INSTALLED: 1.3.0\n  LATEST:    1.4.0\n"),
		).toBe("1.4.0");
		expect(
			parsePipIndex("WARNING: pip index is currently an experimental command.\nAvailable versions: 2.0.0rc1, 1.9.0"),
		).toBe("2.0.0rc1");
		expect(() => parsePipIndex("ERROR: No matching distribution found for nope\n")).toThrow(
			"No matching distribution",
		);
	});

	it("npm view keeps a prerelease tag", () => {
		expect(parseRegistryVersion("1.2.3\n")).toBe("1.2.3");
		expect(parseRegistryVersion("2.0.0-beta.1\n")).toBe("2.0.0-beta.1");
		expect(() => parseRegistryVersion("npm error 404 Not Found\n")).toThrow("404");
	});

	it("owner outputs: pip family here, the package managers through cli-tools' parser", () => {
		expect(parseMcpOwnerLatest({ method: "pip", name: "x", python: "/p" }, "x (3.0.0)\n", "2.0.0")).toBe("3.0.0");
		expect(parseMcpOwnerLatest({ method: "npm", name: "x", prefix: "/p", root: "/p/x" }, "5.1.0\n", "5.0.0")).toBe(
			"5.1.0",
		);
		expect(() => parseMcpOwnerLatest({ method: "uv", name: "x", dir: "/d" }, "", null)).toThrow();
		const runner: RunnerPackage = {
			kind: "runner",
			runner: "uvx",
			ecosystem: "pypi",
			pkg: "x",
			version: "1",
			spec: "x==1",
			pinned: true,
			checkable: true,
		};
		expect(parseRunnerLatest(runner, "x (2.0.0)\n")).toBe("2.0.0");
		expect(parseRunnerLatest({ ...runner, ecosystem: "npm" }, "2.0.0\n")).toBe("2.0.0");
	});
});
