import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executableName, findOnPath, launcherNames, needsShell, spawnArgs, spawnCommand } from "./spawn";
import { RM_TEMP } from "./test-fake-omp";

const made: string[] = [];
afterEach(async () => {
	await Promise.all(made.splice(0).map(dir => fs.rm(dir, RM_TEMP)));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-spawn-"));
	made.push(dir);
	return dir;
}

async function tool(dir: string, name: string, mode = 0o755): Promise<string> {
	const file = path.join(dir, name);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(file, "#!/bin/sh\n", { mode });
	return file;
}

describe("Windows shims", () => {
	it("runs .cmd shims through cmd.exe with the shim path and every argument quoted", () => {
		const shim = "C:\\Users\\First Last\\AppData\\Roaming\\npm\\omp.cmd";
		expect(needsShell(shim, "win32")).toBe(true);
		expect(spawnCommand(shim, "win32")).toBe(`"${shim}"`);
		expect(spawnArgs(shim, ["--append-system-prompt", 'say "hi"'], "win32")).toEqual([
			'"--append-system-prompt"',
			'"say ""hi"""',
		]);
		// A real executable (bun's omp.exe shim) and every macOS bin spawn directly, argv verbatim.
		const exe = "C:\\Users\\First Last\\.bun\\bin\\omp.exe";
		expect(needsShell(exe, "win32")).toBe(false);
		expect(spawnCommand(exe, "win32")).toBe(exe);
		expect(spawnArgs(exe, ['say "hi"'], "win32")).toEqual(['say "hi"']);
		expect(needsShell("C:\\x\\tool.BAT", "win32")).toBe(true);
		expect(needsShell("/opt/tools/omp.cmd", "darwin")).toBe(false);
		expect(spawnCommand("/opt/tools/omp.cmd", "darwin")).toBe("/opt/tools/omp.cmd");
	});

	it("looks a tool up as .exe then .cmd on Windows, never the bare POSIX script; by its name elsewhere", () => {
		expect(launcherNames("codex", "win32")).toEqual(["codex.exe", "codex.cmd"]);
		expect(launcherNames("codex", "darwin")).toEqual(["codex"]);
		expect(executableName("bun", "win32")).toBe("bun.exe");
		expect(executableName("bun", "darwin")).toBe("bun");
		expect(executableName("bun", "other")).toBe("bun");
	});
});

describe("findOnPath", () => {
	it("walks PATH in order, trying every name in each directory, then the extra candidates", async () => {
		const root = await tempDir();
		const a = path.join(root, "a");
		const b = path.join(root, "b");
		const second = await tool(b, "tool-b");
		const first = await tool(b, "tool-a");
		const fallback = await tool(path.join(root, "fallback"), "tool-a");
		const pathEnv = [a, b].join(path.delimiter);
		expect(findOnPath(["tool-a", "tool-b"], pathEnv, process.platform)).toBe(first);
		expect(findOnPath(["tool-b", "tool-a"], pathEnv, process.platform)).toBe(second);
		expect(findOnPath(["missing"], pathEnv, process.platform, [path.join(root, "nope"), fallback])).toBe(fallback);
		expect(findOnPath(["tool-a"], pathEnv, process.platform, [], [first])).toBeNull();
		expect(findOnPath(["tool-a"], "", process.platform)).toBeNull();
	});

	it("never answers with a directory", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, "early", "git"), { recursive: true });
		const git = await tool(path.join(root, "late"), "git");
		const pathEnv = [path.join(root, "early"), path.join(root, "late")].join(path.delimiter);
		expect(findOnPath(["git"], pathEnv, process.platform)).toBe(git);
	});

	it.skipIf(process.platform === "win32")("skips a POSIX file without an execute bit", async () => {
		const root = await tempDir();
		await tool(path.join(root, "early"), "gh", 0o644);
		const gh = await tool(path.join(root, "late"), "gh");
		const pathEnv = [path.join(root, "early"), path.join(root, "late")].join(path.delimiter);
		expect(findOnPath(["gh"], pathEnv, process.platform)).toBe(gh);
	});

	it("splits a Windows PATH on semicolons and takes any file there", async () => {
		const root = await tempDir();
		const exe = await tool(path.join(root, "bin"), "bun.exe", 0o644);
		expect(findOnPath(["bun.exe"], `C:\\nowhere;${path.join(root, "bin")}`, "win32")).toBe(exe);
	});
});
