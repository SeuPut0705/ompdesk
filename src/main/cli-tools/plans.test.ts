/**
 * How each owner checks for and installs a newer version (the commands are fixed in main), how the newest version
 * is read out of each check, and the running-process rule that defers a lazy-loading Node CLI's update on macOS.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliToolId } from "../../shared/cli-update";
import { compareVersions } from "../omp-runtime";
import type { CliDetection, CliOwner } from "./detect";
import { checkCommand, parseLatest, runningIn, updateCommand, waitsForIdle } from "./plans";

const made: string[] = [];
afterEach(async () => {
	await Promise.all(made.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fakeBin(...names: string[]): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-plans-")));
	made.push(dir);
	for (const name of names) await fs.writeFile(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
	return dir;
}

function detection(id: CliToolId, owner: CliOwner | null, over: Partial<CliDetection> = {}): CliDetection {
	return {
		id,
		path: `/opt/bin/${id === "gh-copilot" ? "gh" : id}`,
		real: `/opt/real/${id}`,
		owner,
		skip: null,
		installed: "1.0.0",
		...over,
	};
}

const npmOwner = (prefix: string): CliOwner => ({
	method: "npm",
	name: "@openai/codex",
	prefix,
	root: `${prefix}/lib/node_modules/@openai/codex`,
});

describe("checkCommand", () => {
	it("asks the npm that owns the prefix, falling back to the first npm on PATH, aimed at the package", async () => {
		const prefix = await fakeBin();
		await fs.mkdir(path.join(prefix, "bin"));
		await fs.writeFile(path.join(prefix, "bin", "npm"), "#!/bin/sh\n", { mode: 0o755 });
		const onPath = await fakeBin("npm");
		const own = checkCommand(detection("codex", npmOwner(prefix)), npmOwner(prefix), {
			platform: "darwin",
			pathEnv: onPath,
		});
		expect(own?.spawn).toMatchObject({
			file: path.join(prefix, "bin", "npm"),
			args: ["view", "@openai/codex", "version"],
			shell: false,
		});
		const bare = await fakeBin();
		const fallback = checkCommand(detection("codex", npmOwner(bare)), npmOwner(bare), {
			platform: "darwin",
			pathEnv: onPath,
		});
		expect(fallback?.spawn.file).toBe(path.join(onPath, "npm"));
		expect(
			checkCommand(detection("codex", npmOwner(bare)), npmOwner(bare), { platform: "darwin", pathEnv: "" }),
		).toBeNull();
	});

	it("asks Bun for a Bun global, with its BUN_INSTALL", async () => {
		const bunRoot = await fakeBin();
		await fs.mkdir(path.join(bunRoot, "bin"));
		await fs.writeFile(path.join(bunRoot, "bin", "bun"), "#!/bin/sh\n", { mode: 0o755 });
		const owner: CliOwner = {
			method: "bun",
			name: "@google/gemini-cli",
			bunRoot,
			root: `${bunRoot}/install/global/node_modules/@google/gemini-cli`,
		};
		const command = checkCommand(detection("gemini", owner), owner, { platform: "darwin", pathEnv: "" });
		expect(command).toMatchObject({
			spawn: { file: path.join(bunRoot, "bin", "bun"), args: ["pm", "view", "@google/gemini-cli", "version"] },
			env: { BUN_INSTALL: bunRoot },
		});
	});

	it("asks brew for the formula or the cask, and winget for the id", async () => {
		const brew: CliOwner = { method: "brew", name: "gh", brew: "/opt/homebrew/bin/brew" };
		const cask: CliOwner = { method: "brew-cask", name: "claude-code", brew: "/opt/homebrew/bin/brew" };
		const tools = { platform: "darwin", pathEnv: "" } as const;
		expect(checkCommand(detection("gh", brew), brew, tools)?.spawn.args).toEqual(["outdated", "--json=v2", "gh"]);
		expect(checkCommand(detection("claude", cask), cask, tools)?.spawn.args).toEqual([
			"outdated",
			"--json=v2",
			"--cask",
			"claude-code",
		]);
		const bin = await fakeBin("winget.exe");
		const winget: CliOwner = { method: "winget", id: "GitHub.cli" };
		const command = checkCommand(detection("gh", winget), winget, { platform: "win32", pathEnv: bin });
		expect(command?.spawn.args).toEqual([
			"list",
			"--id",
			"GitHub.cli",
			"-e",
			"--upgrade-available",
			"--accept-source-agreements",
			"--disable-interactivity",
		]);
	});

	it("looks Claude Code up in the npm registry, and leaves the others' own updaters and managed copies to run", async () => {
		const bin = await fakeBin("npm");
		const self: CliOwner = { method: "self" };
		const tools = { platform: "darwin", pathEnv: bin } as const;
		expect(checkCommand(detection("claude", self), self, tools)?.spawn.args).toEqual([
			"view",
			"@anthropic-ai/claude-code",
			"version",
		]);
		expect(checkCommand(detection("cursor-agent", self), self, tools)).toBeNull();
		expect(checkCommand(detection("gh-copilot", self), self, tools)).toBeNull();
		const managed: CliOwner = { method: "managed", item: "gh" };
		expect(checkCommand(detection("gh", managed), managed, tools)).toBeNull();
	});
});

describe("parseLatest", () => {
	it("reads npm's plain version and rejects an answer without one", () => {
		expect(parseLatest({ method: "self" }, "0.51.0\n", "0.50.1")).toBe("0.51.0");
		expect(() => parseLatest({ method: "self" }, "npm ERR! 404 Not Found\n", "0.50.1")).toThrow(/404/);
	});

	it("reads Homebrew's outdated list: the formula's current_version, or the installed one when nothing is outdated", () => {
		const owner: CliOwner = { method: "brew", name: "gh", brew: "brew" };
		const outdated = JSON.stringify({
			formulae: [{ name: "gh", installed_versions: ["2.96.0"], current_version: "2.99.1" }],
			casks: [],
		});
		expect(parseLatest(owner, outdated, "2.96.0")).toBe("2.99.1");
		expect(parseLatest(owner, JSON.stringify({ formulae: [], casks: [] }), "2.96.0")).toBe("2.96.0");
		expect(() => parseLatest(owner, JSON.stringify({ formulae: [], casks: [] }), null)).toThrow(/brew outdated/);
		const cask: CliOwner = { method: "brew-cask", name: "claude-code", brew: "brew" };
		const caskOut = JSON.stringify({
			formulae: [],
			casks: [{ name: "claude-code", installed_versions: ["2.0.1"], current_version: "2.1.0" }],
		});
		expect(parseLatest(cask, caskOut, "2.0.1")).toBe("2.1.0");
	});

	it("reads winget's table: the last version on the package's line", () => {
		const owner: CliOwner = { method: "winget", id: "GitHub.cli" };
		const table =
			"Name        Id          Version Available Source\n-------------------------------\nGitHub CLI  GitHub.cli  2.96.0  2.99.1    winget\n";
		expect(parseLatest(owner, table, "2.96.0")).toBe("2.99.1");
		expect(parseLatest(owner, "No installed package found matching input criteria.\n", "2.96.0")).toBe("2.96.0");
	});
});

describe("version compare", () => {
	it("orders versions numerically, not as text", () => {
		expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareVersions("2.1.296", "2.1.30")).toBeGreaterThan(0);
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
		expect(compareVersions("18.8.7", "18.9.0")).toBeLessThan(0);
	});
});

describe("updateCommand", () => {
	it("updates an npm global with the npm that owns its prefix, pinned to the version the check found", async () => {
		const prefix = await fakeBin();
		await fs.mkdir(path.join(prefix, "bin"));
		await fs.writeFile(path.join(prefix, "bin", "npm"), "#!/bin/sh\n", { mode: 0o755 });
		const owner = npmOwner(prefix) as Extract<CliOwner, { method: "npm" }>;
		const tools = { platform: "darwin", pathEnv: "" } as const;
		expect(updateCommand(detection("codex", owner), owner, "0.51.0", tools)?.spawn.args).toEqual([
			"install",
			"-g",
			"--prefix",
			prefix,
			"@openai/codex@0.51.0",
		]);
		expect(updateCommand(detection("codex", owner), owner, null, tools)?.spawn.args.at(-1)).toBe(
			"@openai/codex@latest",
		);
	});

	it("updates a Bun global in its own BUN_INSTALL, and brew and winget by their package ids", async () => {
		const bunRoot = await fakeBin();
		await fs.mkdir(path.join(bunRoot, "bin"));
		await fs.writeFile(path.join(bunRoot, "bin", "bun"), "#!/bin/sh\n", { mode: 0o755 });
		const bun: CliOwner = { method: "bun", name: "@google/gemini-cli", bunRoot, root: `${bunRoot}/x` };
		const tools = { platform: "darwin", pathEnv: "" } as const;
		expect(updateCommand(detection("gemini", bun), bun, "0.5.0", tools)).toMatchObject({
			spawn: { file: path.join(bunRoot, "bin", "bun"), args: ["install", "-g", "@google/gemini-cli@0.5.0"] },
			env: { BUN_INSTALL: bunRoot },
		});
		const brew: CliOwner = { method: "brew", name: "gh", brew: "/opt/homebrew/bin/brew" };
		expect(updateCommand(detection("gh", brew), brew, "2.99.1", tools)).toMatchObject({
			spawn: { file: "/opt/homebrew/bin/brew", args: ["upgrade", "gh"] },
			env: { HOMEBREW_NO_AUTO_UPDATE: "1" },
		});
		const cask: CliOwner = { method: "brew-cask", name: "claude-code", brew: "/opt/homebrew/bin/brew" };
		expect(updateCommand(detection("claude", cask), cask, null, tools)?.spawn.args).toEqual([
			"upgrade",
			"--cask",
			"claude-code",
		]);
		const bin = await fakeBin("winget.exe");
		const winget: CliOwner = { method: "winget", id: "GitHub.cli" };
		const upgrade = updateCommand(detection("gh", winget), winget, null, { platform: "win32", pathEnv: bin });
		expect(upgrade?.spawn.args).toEqual([
			"upgrade",
			"--id",
			"GitHub.cli",
			"-e",
			"--accept-source-agreements",
			"--accept-package-agreements",
			"--disable-interactivity",
		]);
		expect(updateCommand(detection("gh", winget), winget, null, { platform: "win32", pathEnv: "" })).toBeNull();
	});

	it("runs the tool's own updater from the executable it found, and gh's extension upgrade through gh", () => {
		const self: CliOwner = { method: "self" };
		const tools = { platform: "darwin", pathEnv: "" } as const;
		expect(updateCommand(detection("claude", self), self, "2.2.0", tools)?.spawn).toMatchObject({
			file: "/opt/bin/claude",
			args: ["update"],
		});
		expect(updateCommand(detection("cursor-agent", self), self, null, tools)?.spawn.args).toEqual(["update"]);
		expect(updateCommand(detection("gh-copilot", self), self, null, tools)?.spawn).toMatchObject({
			file: "/opt/bin/gh",
			args: ["extension", "upgrade", "gh-copilot"],
		});
	});

	it("refuses an owner whose package manager is nowhere (no guessing a command)", () => {
		const owner = npmOwner("/nowhere");
		expect(
			updateCommand(detection("codex", owner), owner as Extract<CliOwner, { method: "npm" }>, "1.0.0", {
				platform: "darwin",
				pathEnv: "",
			}),
		).toBeNull();
	});
});

describe("waitsForIdle (the macOS rule for replacing files a running process loads)", () => {
	it("waits for npm and Bun globals, and for a Homebrew Node CLI, but not for single binaries or a vendor's updater", () => {
		expect(waitsForIdle(detection("codex", null), npmOwner("/p"))).toBe(true);
		expect(waitsForIdle(detection("gemini", null), { method: "bun", name: "x", bunRoot: "/b", root: "/b/x" })).toBe(
			true,
		);
		expect(waitsForIdle(detection("gemini", null), { method: "brew", name: "gemini-cli", brew: "brew" })).toBe(true);
		expect(waitsForIdle(detection("codex", null), { method: "brew-cask", name: "codex", brew: "brew" })).toBe(true);
		// gh is one native binary: a running gh keeps its old inode.
		expect(waitsForIdle(detection("gh", null), { method: "brew", name: "gh", brew: "brew" })).toBe(false);
		expect(waitsForIdle(detection("claude", null), { method: "self" })).toBe(false);
		expect(waitsForIdle(detection("cursor-agent", null), { method: "self" })).toBe(false);
		expect(waitsForIdle(detection("gh", null), { method: "managed", item: "gh" })).toBe(false);
		expect(waitsForIdle(detection("gh", null), { method: "winget", id: "GitHub.cli" })).toBe(false);
	});
});

describe("runningIn", () => {
	const ps = [
		"/sbin/launchd",
		"/usr/bin/vim notes.txt",
		"node /Users/u/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js --model gpt-5",
		"/opt/homebrew/Cellar/gemini-cli/0.4.0/libexec/bin/node /opt/homebrew/Cellar/gemini-cli/0.4.0/libexec/lib/node_modules/@google/gemini-cli/dist/index.js",
		"",
	].join("\n");

	it("sees a process of the tool through its package dir", () => {
		const owner = npmOwner("/Users/u/.nvm/versions/node/v22");
		const found = detection("codex", owner, { path: "/Users/u/.nvm/versions/node/v22/bin/codex" });
		expect(runningIn(ps, found, owner)).toBe(true);
	});

	it("sees a Homebrew keg's process and a process named after the tool", () => {
		const brew: CliOwner = { method: "brew", name: "gemini-cli", brew: "brew" };
		expect(runningIn(ps, detection("gemini", brew), brew)).toBe(true);
		const self: CliOwner = { method: "self" };
		expect(runningIn("/Users/u/.local/bin/claude --resume\n", detection("claude", self), self)).toBe(true);
		expect(runningIn("claude\n", detection("claude", self), self)).toBe(true);
	});

	it("answers false when no process of the tool runs", () => {
		const owner = npmOwner("/Users/u/other-prefix");
		expect(
			runningIn(
				ps,
				detection("codex", owner, { path: "/Users/u/other-prefix/bin/codex", real: "/Users/u/other-prefix/x" }),
				owner,
			),
		).toBe(false);
		expect(
			runningIn("/usr/bin/vim notes.txt\n/sbin/launchd\n", detection("claude", { method: "self" }), {
				method: "self",
			}),
		).toBe(false);
		expect(runningIn("", detection("claude", { method: "self" }), { method: "self" })).toBe(false);
	});
});
