import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import {
	expandWindowsEnv,
	findGitBash,
	managedGitRoot,
	managedToolEnv,
	managedToolsDir,
	mergePathLists,
	parseRegQueryValue,
} from "./paths";

const USER_REG = [
	"",
	"HKEY_CURRENT_USER\\Environment",
	"    Path    REG_EXPAND_SZ    %USERPROFILE%\\.bun\\bin;C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps;",
	"",
].join("\r\n");
const MACHINE_REG = [
	"",
	"HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
	"    Path    REG_SZ    C:\\Windows\\system32;C:\\Program Files\\Git\\cmd",
	"",
].join("\r\n");

describe("PATH refresh parsing", () => {
	it("reads the Path value of reg query output, REG_SZ or REG_EXPAND_SZ", () => {
		expect(parseRegQueryValue(USER_REG, "Path")).toBe(
			"%USERPROFILE%\\.bun\\bin;C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps;",
		);
		expect(parseRegQueryValue(MACHINE_REG, "PATH")).toBe("C:\\Windows\\system32;C:\\Program Files\\Git\\cmd");
		expect(
			parseRegQueryValue("ERROR: The system was unable to find the specified registry key or value.", "Path"),
		).toBe(null);
	});

	it("expands %VAR% case-insensitively and leaves unknown names", () => {
		expect(expandWindowsEnv("%UserProfile%\\.bun\\bin;%NOPE%\\x", { USERPROFILE: "C:\\Users\\First Last" })).toBe(
			"C:\\Users\\First Last\\.bun\\bin;%NOPE%\\x",
		);
	});

	it("appends only new entries, comparing case- and slash-insensitively on Windows", () => {
		const base = "C:\\Windows\\System32;C:\\Users\\a\\.bun\\bin\\";
		expect(
			mergePathLists(
				base,
				["c:\\windows\\system32;C:\\Program Files\\Git\\cmd", "C:\\Users\\a\\.bun\\bin"],
				"win32",
				";",
			),
		).toBe("C:\\Windows\\System32;C:\\Users\\a\\.bun\\bin\\;C:\\Program Files\\Git\\cmd");
		expect(mergePathLists("/usr/bin:/Bin", ["/bin", "/usr/bin"], "darwin", ":")).toBe("/usr/bin:/Bin:/bin");
	});
});

describe("managed tools", () => {
	it("lives under %LOCALAPPDATA%\\ompdesk\\tools on Windows and userData elsewhere", () => {
		expect(managedToolsDir("win32", { LOCALAPPDATA: "L" }, "H", "U")).toBe(join("L", "ompdesk", "tools"));
		expect(managedToolsDir("win32", {}, "H", "U")).toBe(join("H", "AppData", "Local", "ompdesk", "tools"));
		expect(managedToolsDir("darwin", { LOCALAPPDATA: "L" }, "H", "U")).toBe(join("U", "tools"));
	});

	it("appends existing managed bin dirs and points GIT_INSTALL_ROOT at a managed PortableGit", () => {
		const tools = join("T", "tools");
		const git = managedGitRoot(tools);
		const present = new Set([join(git, "cmd"), join(git, "bin", "bash.exe"), join(tools, "node", "bin")]);
		const exists = (file: string) => present.has(file);
		expect(managedToolEnv({ PATH: "A;B" }, tools, "win32", exists)).toEqual({
			PATH: `A;B;${join(git, "cmd")}`,
			GIT_INSTALL_ROOT: git,
		});
		// The user's own GIT_INSTALL_ROOT wins.
		expect(managedToolEnv({ PATH: "", GIT_INSTALL_ROOT: "mine" }, tools, "win32", exists)).not.toHaveProperty(
			"GIT_INSTALL_ROOT",
		);
		// No PortableGit yet: nothing to point at.
		expect(managedToolEnv({ PATH: "" }, tools, "win32", () => false)).toEqual({ PATH: "" });
		expect(managedToolEnv({ PATH: "/usr/bin" }, tools, "darwin", exists)).toEqual({
			PATH: ["/usr/bin", join(tools, "node", "bin")].join(":"),
		});
	});
});

describe("findGitBash", () => {
	it("follows stock's Git for Windows roots in order, then a git.exe on PATH with bin\\bash.exe", () => {
		const bash = (root: string) => join(root, "bin", "bash.exe");
		const roots = {
			ProgramFiles: "PF",
			"ProgramFiles(x86)": "PF86",
			LOCALAPPDATA: "LA",
			GIT_INSTALL_ROOT: "GIR",
			SCOOP: "SC",
			USERPROFILE: "UP",
		};
		const only =
			(...files: string[]) =>
			(file: string) =>
				files.includes(file);
		expect(findGitBash(roots, only(bash(join("PF", "Git")), bash("GIR")))).toBe(bash(join("PF", "Git")));
		expect(findGitBash(roots, only(bash(join("LA", "Programs", "Git")), bash("GIR")))).toBe(
			bash(join("LA", "Programs", "Git")),
		);
		expect(findGitBash(roots, only(bash("GIR")))).toBe(bash("GIR"));
		expect(findGitBash(roots, only(bash(join("UP", "scoop", "apps", "git", "current"))))).toBe(
			bash(join("UP", "scoop", "apps", "git", "current")),
		);
		const gitCmd = join("X", "Git", "cmd");
		expect(
			findGitBash(
				{ PATH: `C:\\Windows\\System32;${gitCmd}` },
				only(join(gitCmd, "git.exe"), bash(join("X", "Git"))),
			),
		).toBe(bash(join("X", "Git")));
		// WSL's System32 bash.exe is not Git Bash.
		expect(
			findGitBash({ PATH: "C:\\Windows\\System32" }, only(join("C:\\Windows\\System32", "bash.exe"))),
		).toBeNull();
	});
});

/** Stock omp's shell resolver, when this machine has omp installed (skipped otherwise, e.g. on CI). */
const stockProcmgr = join(
	process.env.HOME ?? process.env.USERPROFILE ?? "",
	".bun",
	"install",
	"global",
	"node_modules",
	"@oh-my-pi",
	"pi-utils",
	"src",
	"procmgr.ts",
);
const bun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!existsSync(stockProcmgr) || !bun)("stock omp's Windows shell", () => {
	it("is the managed PortableGit's bash.exe for an omp spawned with managedToolEnv", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ompdesk-gitbash-"));
		try {
			const tools = join(dir, "tools");
			const bash = join(managedGitRoot(tools), "bin", "bash.exe");
			await mkdir(dirname(bash), { recursive: true });
			await mkdir(join(managedGitRoot(tools), "cmd"), { recursive: true });
			await writeFile(bash, "");
			// A machine without Git for Windows: no ProgramFiles Git, nothing on PATH.
			const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe", ...managedToolEnv({ PATH: "" }, tools, "win32") };
			const script = `import { resolveWindowsShell } from ${JSON.stringify(stockProcmgr)};\nconsole.log(resolveWindowsShell(JSON.parse(process.env.OMPDESK_ENV)));`;
			const result = spawnSync("bun", ["-e", script], {
				encoding: "utf8",
				env: { ...process.env, OMPDESK_ENV: JSON.stringify(env) },
			});
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe(bash);
			// And with the same layout, OMPdesk's own discovery agrees with stock.
			expect(findGitBash(env)).toBe(bash);
		} finally {
			await rm(dir, RM_TEMP);
		}
	});
});
