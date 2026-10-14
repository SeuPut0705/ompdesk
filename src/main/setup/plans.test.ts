import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SetupPresence } from "../../shared/setup";
import { type ArchiveRelease, buildPlan, manualSteps, type PlanContext, PORTABLE_GIT, selectMethod } from "./plans";

const missing: SetupPresence = { kind: "missing" };
const present: SetupPresence = { kind: "present", version: "1.0.0", path: "/x" };
const outdated: SetupPresence = {
	kind: "outdated",
	version: "18.0.0",
	minimum: "18.8.7",
	path: "/home/u/.bun/bin/omp",
};

const mac: PlanContext = {
	platform: "darwin",
	arch: "arm64",
	bunInstall: "/home/u/.bun",
	toolsDir: "/data/tools",
	bun: "/home/u/.bun/bin/bun",
	omp: null,
	brew: "/opt/homebrew/bin/brew",
	winget: null,
	systemRoot: "C:\\Windows",
};
const win: PlanContext = {
	platform: "win32",
	arch: "x64",
	bunInstall: "C:\\Users\\First Last\\.bun",
	toolsDir: "C:\\Users\\First Last\\AppData\\Local\\ompdesk\\tools",
	bun: "C:\\Users\\First Last\\.bun\\bin\\bun.exe",
	omp: null,
	brew: null,
	winget: "C:\\Users\\First Last\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
	systemRoot: "C:\\Windows",
};

function decodePowerShell(args: string[]): string {
	const encoded = args[args.indexOf("-EncodedCommand") + 1] ?? "";
	return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("selectMethod", () => {
	it("never plans an install for something present, or on an unsupported platform", () => {
		for (const item of ["bun", "omp", "git", "gh", "node"] as const) {
			expect(selectMethod(item, present, mac)).toBeNull();
			expect(selectMethod(item, missing, { ...mac, platform: "other" })).toBeNull();
		}
	});

	it("picks Bun's script, the bun global install, and omp update for an omp below the minimum", () => {
		expect(selectMethod("bun", missing, mac)).toBe("bun-script");
		expect(selectMethod("bun", missing, win)).toBe("bun-script");
		expect(selectMethod("omp", missing, mac)).toBe("bun-global");
		expect(selectMethod("omp", { kind: "broken", detail: "x", path: "/x" }, mac)).toBe("bun-global");
		expect(selectMethod("omp", outdated, { ...mac, omp: "/home/u/.bun/bin/omp" })).toBe("omp-update");
	});

	it("installs Git through the Xcode tools on macOS and PortableGit on Windows, never winget", () => {
		expect(selectMethod("git", missing, mac)).toBe("xcode-select");
		expect(selectMethod("git", missing, win)).toBe("portable-git");
		expect(selectMethod("git", missing, { ...win, winget: null })).toBe("portable-git");
	});

	it("uses Homebrew or an archive on macOS, winget or nothing on Windows, for gh and Node", () => {
		for (const item of ["gh", "node"] as const) {
			expect(selectMethod(item, missing, mac)).toBe("brew");
			expect(selectMethod(item, missing, { ...mac, brew: null })).toBe("archive");
			expect(selectMethod(item, missing, win)).toBe("winget");
			expect(selectMethod(item, missing, { ...win, winget: null })).toBeNull();
		}
		// A Node older than REA's engines is replaced the same way.
		expect(selectMethod("node", { kind: "outdated", version: "v18.0.0", minimum: "^22", path: null }, mac)).toBe(
			"brew",
		);
	});
});

describe("buildPlan", () => {
	it("runs Bun's official installers, user-level, with no shell on Windows", () => {
		const posix = buildPlan("bun", "bun-script", mac);
		expect(posix?.spawn).toEqual({
			file: "/bin/bash",
			args: ["-c", "set -o pipefail; curl -fsSL https://bun.sh/install | bash"],
			shell: false,
		});
		expect(posix?.command).toBe("curl -fsSL https://bun.sh/install | bash");
		expect(posix?.location).toBe("/home/u/.bun");
		const windows = buildPlan("bun", "bun-script", win);
		expect(windows?.spawn.file).toBe(join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
		expect(windows?.spawn.args).toEqual([
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			"irm bun.sh/install.ps1 | iex",
		]);
		expect(windows?.spawn.shell).toBe(false);
		expect(windows?.prompt).toBeNull();
	});

	it("installs omp with the absolute bun path, and refuses without Bun", () => {
		const plan = buildPlan("omp", "bun-global", win);
		expect(plan?.spawn).toEqual({
			file: win.bun,
			args: ["install", "-g", "@oh-my-pi/pi-coding-agent"],
			shell: false,
		});
		expect(plan?.command).toBe(`"${win.bun}" install -g @oh-my-pi/pi-coding-agent`);
		expect(buildPlan("omp", "bun-global", { ...mac, bun: null })).toBeNull();
	});

	it("updates omp through its own bin, quoting a Windows .cmd shim for cmd.exe", () => {
		expect(buildPlan("omp", "omp-update", { ...mac, omp: "/u/.bun/bin/omp" })?.spawn).toEqual({
			file: "/u/.bun/bin/omp",
			args: ["update"],
			shell: false,
		});
		const shim = "C:\\Users\\First Last\\AppData\\Roaming\\npm\\omp.cmd";
		expect(buildPlan("omp", "omp-update", { ...win, omp: shim })?.spawn).toEqual({
			file: `"${shim}"`,
			args: ['"update"'],
			shell: true,
		});
		expect(buildPlan("omp", "omp-update", mac)).toBeNull();
	});

	it("downloads the pinned PortableGit, checks its published SHA-256, and extracts it without admin", () => {
		const plan = buildPlan("git", "portable-git", win);
		expect(plan?.prompt).toBeNull();
		expect(plan?.location).toBe(join(win.toolsDir, "git"));
		const script = decodePowerShell(plan?.spawn.args ?? []);
		expect(plan?.command).toBe(script);
		expect(script).toContain(PORTABLE_GIT.x64.url);
		expect(script).toContain(PORTABLE_GIT.x64.sha256);
		expect(script).toContain("Get-FileHash -Algorithm SHA256");
		expect(script).toContain(`$dest = '${join(win.toolsDir, "git")}'`);
		expect(script).not.toMatch(/RunAs|winget/);
		expect(decodePowerShell(buildPlan("git", "portable-git", { ...win, arch: "arm64" })?.spawn.args ?? [])).toContain(
			PORTABLE_GIT.arm64.sha256,
		);
		// A quote in the profile path cannot end the PowerShell string.
		const quoted = decodePowerShell(
			buildPlan("git", "portable-git", { ...win, toolsDir: "C:\\Users\\O'Brien\\tools" })?.spawn.args ?? [],
		);
		expect(quoted).toContain(`'${join("C:\\Users\\O''Brien\\tools", "git")}'`);
	});

	it("asks macOS for the Command Line Tools, which shows its own dialog", () => {
		expect(buildPlan("git", "xcode-select", mac)).toMatchObject({
			spawn: { file: "/usr/bin/xcode-select", args: ["--install"], shell: false },
			prompt: "dialog",
		});
	});

	it("passes winget the exact id and both agreement flags, and warns about UAC", () => {
		for (const [item, id] of [
			["gh", "GitHub.cli"],
			["node", "OpenJS.NodeJS.LTS"],
		] as const) {
			const plan = buildPlan(item, "winget", win);
			expect(plan?.spawn.args).toEqual([
				"install",
				"--id",
				id,
				"-e",
				"--accept-source-agreements",
				"--accept-package-agreements",
			]);
			expect(plan?.prompt).toBe("uac");
		}
		expect(buildPlan("gh", "winget", { ...win, winget: null })).toBeNull();
	});

	it("installs gh and node with Homebrew when it exists", () => {
		expect(buildPlan("gh", "brew", mac)?.spawn).toEqual({ file: mac.brew, args: ["install", "gh"], shell: false });
		expect(buildPlan("node", "brew", mac)?.spawn).toEqual({
			file: mac.brew,
			args: ["install", "node"],
			shell: false,
		});
	});

	it("unpacks an archive into the managed tools dir only after its SHA-256 matched", () => {
		const release: ArchiveRelease = {
			item: "node",
			version: "v24.11.0",
			file: "node-v24.11.0-darwin-arm64.tar.gz",
			url: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.gz",
			sha256: "a".repeat(64),
		};
		expect(buildPlan("node", "archive", mac)).toBeNull();
		const plan = buildPlan("node", "archive", mac, release);
		const script = plan?.spawn.args[1] ?? "";
		expect(plan?.location).toBe("/data/tools/node");
		expect(script.startsWith("set -euo pipefail")).toBe(true);
		const verify = script.indexOf("shasum -a 256 -c -");
		expect(verify).toBeGreaterThan(script.indexOf(release.url));
		expect(script.indexOf("mv ")).toBeGreaterThan(verify);
		expect(script).toContain(`'${"a".repeat(64)}  '`);
		expect(buildPlan("gh", "archive", mac, release)).toBeNull();
	});
});

describe("manualSteps", () => {
	it("gives the per-platform command and the official page", () => {
		expect(manualSteps("bun", null, "win32").commands[0]).toContain("install.ps1");
		expect(manualSteps("omp", outdated, "darwin").commands).toEqual(["omp update"]);
		expect(manualSteps("omp", missing, "darwin").commands).toEqual(["bun install -g @oh-my-pi/pi-coding-agent"]);
		expect(manualSteps("git", null, "darwin").commands).toEqual(["xcode-select --install"]);
		expect(manualSteps("node", null, "win32")).toEqual({
			commands: ["winget install --id OpenJS.NodeJS.LTS -e"],
			url: "https://nodejs.org/en/download",
		});
	});
});
