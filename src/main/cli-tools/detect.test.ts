/**
 * Which owner a vendor CLI's resolved executable belongs to (brew formula/cask, bun/npm global, the tool's own
 * updater, winget, machine setup's managed dir) and which copies OMPdesk leaves alone (system, bundled in another
 * app such as a Codex inside ChatGPT.app, admin-owned), plus the real-filesystem detection around it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CLI_TOOLS } from "../../shared/cli-update";
import { CLI_TOOL_SPECS, relevantTools } from "./catalog";
import {
	classifyInstall,
	cmdShimTarget,
	detectCliTool,
	findBrew,
	ghCopilotVersion,
	type InstallContext,
	writableTarget,
} from "./detect";

const MAC: InstallContext = {
	platform: "darwin",
	toolsDir: "/Users/u/Library/Application Support/ompdesk/tools",
	brew: "/opt/homebrew/bin/brew",
};
const WIN: InstallContext = {
	platform: "win32",
	toolsDir: "C:\\Users\\u\\AppData\\Local\\ompdesk\\tools",
	brew: null,
};

describe("classifyInstall", () => {
	it("names the Homebrew formula and cask from the keg or Caskroom path", () => {
		expect(classifyInstall("/opt/homebrew/Cellar/gh/2.96.0/bin/gh", CLI_TOOL_SPECS.gh, MAC)).toEqual({
			owner: { method: "brew", name: "gh", brew: "/opt/homebrew/bin/brew" },
			skip: null,
		});
		// A Node CLI's formula keeps its package tree under libexec: the keg wins over the node_modules match.
		expect(
			classifyInstall(
				"/opt/homebrew/Cellar/gemini-cli/0.4.0/libexec/lib/node_modules/@google/gemini-cli/dist/index.js",
				CLI_TOOL_SPECS.gemini,
				MAC,
			),
		).toEqual({ owner: { method: "brew", name: "gemini-cli", brew: "/opt/homebrew/bin/brew" }, skip: null });
		expect(classifyInstall("/opt/homebrew/Caskroom/codex/0.46.0/codex-aarch64", CLI_TOOL_SPECS.codex, MAC)).toEqual({
			owner: { method: "brew-cask", name: "codex", brew: "/opt/homebrew/bin/brew" },
			skip: null,
		});
		expect(classifyInstall("/opt/homebrew/Caskroom/claude-code/2.0.1/claude", CLI_TOOL_SPECS.claude, MAC)).toEqual({
			owner: { method: "brew-cask", name: "claude-code", brew: "/opt/homebrew/bin/brew" },
			skip: null,
		});
	});

	it("leaves a Homebrew path alone when this Mac has no brew to upgrade it with", () => {
		expect(
			classifyInstall("/opt/homebrew/Cellar/gh/2.96.0/bin/gh", CLI_TOOL_SPECS.gh, { ...MAC, brew: null }),
		).toEqual({
			owner: null,
			skip: "unknown-install",
		});
	});

	it("names the Bun and npm global package, with the prefix that owns it", () => {
		expect(
			classifyInstall(
				"/Users/u/.bun/install/global/node_modules/@google/gemini-cli/dist/index.js",
				CLI_TOOL_SPECS.gemini,
				MAC,
			),
		).toEqual({
			owner: {
				method: "bun",
				name: "@google/gemini-cli",
				bunRoot: "/Users/u/.bun",
				root: "/Users/u/.bun/install/global/node_modules/@google/gemini-cli",
			},
			skip: null,
		});
		expect(
			classifyInstall(
				"/Users/u/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin/codex.js",
				CLI_TOOL_SPECS.codex,
				MAC,
			),
		).toEqual({
			owner: {
				method: "npm",
				name: "@openai/codex",
				prefix: "/Users/u/.nvm/versions/node/v22.1.0",
				root: "/Users/u/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex",
			},
			skip: null,
		});
	});

	it("reads a Windows npm global package (no lib dir) and keeps Windows paths native", () => {
		expect(
			classifyInstall(
				"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
				CLI_TOOL_SPECS.codex,
				WIN,
			),
		).toEqual({
			owner: {
				method: "npm",
				name: "@openai/codex",
				prefix: "C:\\Users\\u\\AppData\\Roaming\\npm",
				root: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex",
			},
			skip: null,
		});
	});

	it("uses the tool's own updater where the vendor has one, even for its npm or Bun install", () => {
		expect(
			classifyInstall(
				"/Users/u/.local/share/cursor-agent/versions/2026.01.01/cursor-agent",
				CLI_TOOL_SPECS["cursor-agent"],
				MAC,
			),
		).toEqual({ owner: { method: "self" }, skip: null });
		expect(classifyInstall("/Users/u/.local/share/claude/versions/2.0.1", CLI_TOOL_SPECS.claude, MAC)).toEqual({
			owner: { method: "self" },
			skip: null,
		});
		expect(
			classifyInstall(
				"/Users/u/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js",
				CLI_TOOL_SPECS.claude,
				MAC,
			),
		).toEqual({ owner: { method: "self" }, skip: null });
	});

	it("names the winget package of a Windows gh", () => {
		for (const real of [
			"C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe\\gh.exe",
			"C:\\Program Files\\GitHub CLI\\gh.exe",
		]) {
			expect(classifyInstall(real, CLI_TOOL_SPECS.gh, WIN)).toEqual({
				owner: { method: "winget", id: "GitHub.cli" },
				skip: null,
			});
		}
	});

	it("owns gh and Node only inside machine setup's managed tools dir", () => {
		expect(classifyInstall(`${MAC.toolsDir}/gh/bin/gh`, CLI_TOOL_SPECS.gh, MAC)).toEqual({
			owner: { method: "managed", item: "gh" },
			skip: null,
		});
		expect(classifyInstall(`${MAC.toolsDir}/node/bin/node`, CLI_TOOL_SPECS.node, MAC)).toEqual({
			owner: { method: "managed", item: "node" },
			skip: null,
		});
		expect(classifyInstall("/opt/homebrew/Cellar/node/24.0.0/bin/node", CLI_TOOL_SPECS.node, MAC)).toEqual({
			owner: null,
			skip: "unknown-install",
		});
		// A vendor CLI the user put under the managed dir is not machine setup's.
		expect(classifyInstall(`${MAC.toolsDir}/claude`, CLI_TOOL_SPECS.claude, MAC)).toEqual({
			owner: null,
			skip: "unknown-install",
		});
		expect(classifyInstall(`${WIN.toolsDir}\\gh\\bin\\gh.exe`.toUpperCase(), CLI_TOOL_SPECS.gh, WIN)).toEqual({
			owner: { method: "managed", item: "gh" },
			skip: null,
		});
	});

	it("skips what the operating system owns", () => {
		for (const real of [
			"/usr/bin/gh",
			"/Library/Developer/CommandLineTools/usr/bin/git",
			"/Applications/Xcode.app/Contents/Developer/usr/bin/git",
		]) {
			expect(classifyInstall(real, CLI_TOOL_SPECS.gh, MAC)).toEqual({ owner: null, skip: "system" });
		}
		expect(classifyInstall("C:\\Windows\\System32\\gh.exe", CLI_TOOL_SPECS.gh, WIN)).toEqual({
			owner: null,
			skip: "system",
		});
	});

	it("skips a copy another app ships inside its bundle (a Codex inside ChatGPT.app)", () => {
		expect(classifyInstall("/Applications/ChatGPT.app/Contents/Resources/codex", CLI_TOOL_SPECS.codex, MAC)).toEqual({
			owner: null,
			skip: "bundled",
		});
		expect(
			classifyInstall("C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\\codex.exe", CLI_TOOL_SPECS.codex, WIN),
		).toEqual({ owner: null, skip: "bundled" });
	});

	it("skips an install it cannot tell the owner of (a version manager, a copy by hand)", () => {
		expect(classifyInstall("/Users/u/.local/bin/codex", CLI_TOOL_SPECS.codex, MAC)).toEqual({
			owner: null,
			skip: "unknown-install",
		});
		expect(classifyInstall("/Users/u/bin/gemini", CLI_TOOL_SPECS.gemini, MAC)).toEqual({
			owner: null,
			skip: "unknown-install",
		});
	});
});

describe("writableTarget", () => {
	it("is the directory each owner's update writes into", () => {
		expect(writableTarget({ method: "brew", name: "gh", brew: "/opt/homebrew/bin/brew" }, "/x", MAC)).toBe(
			"/opt/homebrew",
		);
		expect(
			writableTarget(
				{ method: "npm", name: "@openai/codex", prefix: "/p", root: "/p/lib/node_modules/@openai/codex" },
				"/x",
				MAC,
			),
		).toBe("/p/lib/node_modules/@openai");
		expect(writableTarget({ method: "managed", item: "gh" }, "/x", MAC)).toBe(MAC.toolsDir);
		expect(writableTarget({ method: "self" }, "/a/b/claude", MAC)).toBe("/a/b");
	});
});

describe("relevantTools", () => {
	it("maps each connected provider to its vendor CLI and always lists machine setup's tools", () => {
		expect([...relevantTools([], CLI_TOOLS).keys()]).toEqual(["gh", "node"]);
		expect([...relevantTools(["anthropic"], CLI_TOOLS).keys()]).toEqual(["claude", "gh", "node"]);
		expect(relevantTools(["openai-codex", "openai", "cursor"], CLI_TOOLS).get("codex")).toEqual([
			"openai-codex",
			"openai",
		]);
		expect([...relevantTools(["google-gemini-cli"], CLI_TOOLS).keys()]).toContain("gemini");
		expect([...relevantTools(["cursor"], CLI_TOOLS).keys()]).toContain("cursor-agent");
		expect([...relevantTools(["github-copilot"], CLI_TOOLS).keys()]).toEqual(["copilot", "gh", "gh-copilot", "node"]);
		// A provider with no vendor CLI adds nothing.
		expect([...relevantTools(["openrouter"], CLI_TOOLS).keys()]).toEqual(["gh", "node"]);
	});
});

describe("ghCopilotVersion", () => {
	it("reads the gh-copilot extension's version, and says absent when gh lists none", () => {
		expect(ghCopilotVersion("gh copilot\tgithub/gh-copilot\tv1.0.5\n")).toBe("1.0.5");
		expect(ghCopilotVersion("gh dash\tdlvhdr/gh-dash\tv4.1.0\n")).toBeUndefined();
		expect(ghCopilotVersion("")).toBeUndefined();
	});
});

// What npm's cmd-shim writes for `npm install -g @openai/codex` on Windows (a JS bin with a node shebang).
const NPM_CMD_SHIM = [
	"@ECHO off",
	"GOTO start",
	":find_dp0",
	"SET dp0=%~dp0",
	"EXIT /b",
	":start",
	"SETLOCAL",
	"CALL :find_dp0",
	"",
	'IF EXIST "%dp0%\\node.exe" (',
	'  SET "_prog=%dp0%\\node.exe"',
	") ELSE (",
	'  SET "_prog=node"',
	")",
	"",
	'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
	"",
].join("\r\n");

describe("cmdShimTarget (Windows npm globals are .cmd shims, not links)", () => {
	it("reads the package file a shim runs, so its npm prefix owns it", () => {
		const shim = "C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd";
		const target = cmdShimTarget(shim, NPM_CMD_SHIM);
		expect(target).toBe("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
		expect(classifyInstall(target ?? shim, CLI_TOOL_SPECS.codex, WIN).owner).toEqual({
			method: "npm",
			name: "@openai/codex",
			prefix: "C:\\Users\\u\\AppData\\Roaming\\npm",
			root: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex",
		});
	});

	it("reads older npm's %~dp0 shims and a native bin's, and names nothing for another .cmd", () => {
		const old = [
			'@IF EXIST "%~dp0\\node.exe" (',
			'  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*',
			") ELSE (",
			"  @SETLOCAL",
			"  @SET PATHEXT=%PATHEXT:;.JS;=;%",
			'  node  "%~dp0\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*',
			")",
		].join("\r\n");
		expect(cmdShimTarget("D:\\npm\\gemini.cmd", old)).toBe(
			"D:\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js",
		);
		expect(
			cmdShimTarget("D:\\npm\\tool.cmd", '@ECHO off\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n'),
		).toBe("D:\\npm\\node_modules\\tool\\bin\\tool.exe");
		expect(cmdShimTarget("D:\\bin\\codex.cmd", "@echo off\r\ncodex-real.exe %*\r\n")).toBeNull();
	});
});

const made: string[] = [];
// Not the developer's own Homebrew: its claude or gh would answer for a PATH that holds none.
process.env.OMP_GUI_TEST_BREW_DIRS = "";
afterAll(() => {
	delete process.env.OMP_GUI_TEST_BREW_DIRS;
});
afterEach(async () => {
	for (const dir of made.splice(0)) {
		await fs.chmod(dir, 0o755).catch(() => undefined);
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function sandbox(): Promise<{ root: string; bin: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-detect-")));
	made.push(root);
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	return { root, bin };
}

async function script(file: string, body = "echo fake\n"): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
	return file;
}

describe.skipIf(process.platform === "win32")("detectCliTool", () => {
	const never = async () => {
		throw new Error("the version comes from the package manifest");
	};

	it("finds nothing for a tool that is not installed (a vendor CLI is never installed here)", async () => {
		const { root, bin } = await sandbox();
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		expect(await detectCliTool("claude", { pathEnv: bin, env: {}, ctx })).toBeNull();
	});

	it("follows the symlink to a Homebrew keg and reads its version from the tool", async () => {
		const { root, bin } = await sandbox();
		const prefix = path.join(root, "homebrew");
		const real = await script(path.join(prefix, "Cellar", "gh", "2.96.0", "bin", "gh"));
		await fs.symlink(real, path.join(bin, "gh"));
		const brew = await script(path.join(prefix, "bin", "brew"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew };
		const detection = await detectCliTool("gh", {
			pathEnv: bin,
			env: {},
			ctx,
			probe: async (_bin, args) => {
				expect(args).toEqual(["--version"]);
				return "gh version 2.96.0 (2026-01-01)\n";
			},
		});
		expect(detection).toMatchObject({
			id: "gh",
			path: path.join(bin, "gh"),
			real,
			installed: "2.96.0",
			skip: null,
			owner: { method: "brew", name: "gh", brew },
		});
	});

	it("reads an npm global package's version from its manifest and names its prefix", async () => {
		const { root, bin } = await sandbox();
		const prefix = path.join(root, "node-prefix");
		const pkg = path.join(prefix, "lib", "node_modules", "@openai", "codex");
		const real = await script(path.join(pkg, "bin", "codex.js"));
		await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.50.1" }));
		await fs.symlink(real, path.join(bin, "codex"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		const detection = await detectCliTool("codex", { pathEnv: bin, env: {}, ctx, probe: never });
		expect(detection).toMatchObject({
			installed: "0.50.1",
			skip: null,
			owner: { method: "npm", name: "@openai/codex", prefix, root: pkg },
		});
	});

	it("skips an npm prefix only an administrator can write, and never asks for admin rights", async () => {
		const { root, bin } = await sandbox();
		const prefix = path.join(root, "locked-prefix");
		const modules = path.join(prefix, "lib", "node_modules");
		const pkg = path.join(modules, "@openai", "codex");
		const real = await script(path.join(pkg, "bin", "codex.js"));
		await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ version: "0.50.1" }));
		await fs.symlink(real, path.join(bin, "codex"));
		await fs.chmod(path.join(modules, "@openai"), 0o555);
		made.unshift(path.join(modules, "@openai"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		const detection = await detectCliTool("codex", { pathEnv: bin, env: {}, ctx, probe: never });
		expect(detection).toMatchObject({ owner: null, skip: "not-writable", installed: "0.50.1" });
	});

	it("skips a Codex shipped inside another app's bundle but still reports its version", async () => {
		const { root, bin } = await sandbox();
		const real = await script(path.join(root, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"));
		await fs.symlink(real, path.join(bin, "codex"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		const detection = await detectCliTool("codex", {
			pathEnv: bin,
			env: {},
			ctx,
			probe: async () => "codex-cli 0.46.0\n",
		});
		expect(detection).toMatchObject({ owner: null, skip: "bundled", installed: "0.46.0" });
	});

	it("lists Node only as the copy in the managed tools dir", async () => {
		const { root, bin } = await sandbox();
		const tools = path.join(root, "tools");
		await fs.symlink(await script(path.join(root, "elsewhere", "node")), path.join(bin, "node"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: tools, brew: null };
		expect(await detectCliTool("node", { pathEnv: bin, env: {}, ctx })).toBeNull();

		const managed = await script(path.join(tools, "node", "bin", "node"));
		const detection = await detectCliTool("node", {
			pathEnv: path.dirname(managed),
			env: {},
			ctx,
			probe: async () => "v24.11.0\n",
		});
		expect(detection).toMatchObject({ owner: { method: "managed", item: "node" }, installed: "24.11.0", skip: null });
	});

	it("detects the gh-copilot extension through gh, and nothing when gh lists none", async () => {
		const { root, bin } = await sandbox();
		await fs.symlink(await script(path.join(root, "gh-real", "gh")), path.join(bin, "gh"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		const present = await detectCliTool("gh-copilot", {
			pathEnv: bin,
			env: {},
			ctx,
			probe: async (_bin, args) => {
				expect(args).toEqual(["extension", "list"]);
				return "gh copilot\tgithub/gh-copilot\tv1.0.5\n";
			},
		});
		expect(present).toMatchObject({ id: "gh-copilot", installed: "1.0.5", owner: { method: "self" }, skip: null });
		expect(await detectCliTool("gh-copilot", { pathEnv: bin, env: {}, ctx, probe: async () => "" })).toBeNull();
	});
});

describe.runIf(process.platform === "win32")("detectCliTool on Windows", () => {
	it("follows an npm global's .cmd shim to its package, and never takes the bare POSIX script beside it", async () => {
		const { root, bin } = await sandbox();
		const pkg = path.join(bin, "node_modules", "@openai", "codex");
		await fs.mkdir(path.join(pkg, "bin"), { recursive: true });
		await fs.writeFile(path.join(pkg, "bin", "codex.js"), "");
		await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.50.1" }));
		await fs.writeFile(path.join(bin, "codex"), "#!/bin/sh\n");
		const ctx: InstallContext = { platform: "win32", toolsDir: path.join(root, "tools"), brew: null };
		const never = async () => {
			throw new Error("the version comes from the package manifest");
		};
		expect(await detectCliTool("codex", { pathEnv: bin, env: {}, ctx, probe: never })).toBeNull();
		await fs.writeFile(path.join(bin, "codex.cmd"), NPM_CMD_SHIM);
		expect(await detectCliTool("codex", { pathEnv: bin, env: {}, ctx, probe: never })).toMatchObject({
			path: path.join(bin, "codex.cmd"),
			real: path.join(pkg, "bin", "codex.js"),
			installed: "0.50.1",
			skip: null,
			owner: { method: "npm", name: "@openai/codex", prefix: bin, root: pkg },
		});
	});
});

describe("findBrew", () => {
	it("finds brew on PATH, never on Windows", async () => {
		const { bin } = await sandbox();
		const brew = await script(path.join(bin, "brew"));
		process.env.OMP_GUI_TEST_BREW_DIRS = "";
		try {
			expect(findBrew(bin, "darwin")).toBe(brew);
			expect(findBrew("", "darwin")).toBeNull();
			expect(findBrew(bin, "win32")).toBeNull();
		} finally {
			delete process.env.OMP_GUI_TEST_BREW_DIRS;
		}
	});
});
