import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SetupPresence } from "../../shared/setup";
import {
	type ArchiveRelease,
	buildPlan,
	manualSteps,
	type PlanContext,
	PORTABLE_GIT,
	selectMethod,
	type TailscaleRelease,
	tailscaleMsiArch,
} from "./plans";

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

	it("upgrades a Bun older than omp's engines with `bun upgrade`, and installs it afresh without one", () => {
		const tooOld: SetupPresence = { kind: "outdated", version: "1.4.2", minimum: "1.4.4", path: mac.bun };
		expect(selectMethod("bun", tooOld, mac)).toBe("bun-upgrade");
		expect(selectMethod("bun", tooOld, win)).toBe("bun-upgrade");
		expect(selectMethod("bun", tooOld, { ...mac, bun: null })).toBe("bun-script");
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
		expect(windows?.spawn.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		expect(windows?.spawn.args.slice(0, -1)).toEqual([
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
		]);
		expect(decodePowerShell(windows?.spawn.args ?? [])).toBe(windows?.command);
		expect(windows?.spawn.shell).toBe(false);
		expect(windows?.prompt).toBeNull();
		expect(windows?.location).toBe(win.bunInstall);
	});

	it("installs Bun on Windows over a running or missing bun.exe, and fails when no Bun answers", () => {
		const script = buildPlan("bun", "bun-script", win)?.command ?? "";
		const step = (text: string) => {
			const at = script.indexOf(text);
			expect(at, text).toBeGreaterThanOrEqual(0);
			return at;
		};
		expect(script).toContain("$exe = Join-Path 'C:\\Users\\First Last\\.bun' 'bin\\bun.exe'");
		// install.ps1 deletes bun.exe first, which fails while any process runs it; renaming a running exe works.
		const aside = step("Move-Item -LiteralPath $exe -Destination $aside");
		const install = step("Invoke-RestMethod -Uri 'https://bun.sh/install.ps1' | Invoke-Expression");
		const verify = step("& $exe --version");
		const restore = step("Move-Item -LiteralPath $aside -Destination $exe");
		const fail = step("throw 'Bun was not installed");
		expect(aside).toBeLessThan(install);
		expect(install).toBeLessThan(verify);
		expect(verify).toBeLessThan(restore);
		expect(restore).toBeLessThan(fail);
		// A missing bun.exe (a `bun upgrade` that could not put its new one in place) moves nothing.
		expect(script).toContain("if (Test-Path -LiteralPath $exe) {");
	});

	it.runIf(process.platform === "win32")("is a script Windows PowerShell parses", () => {
		const script = buildPlan("bun", "bun-script", win)?.command ?? "";
		const check =
			"$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:OMPDESK_SCRIPT, [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.Message }; exit $errors.Count";
		const parsed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], {
			env: { ...process.env, OMPDESK_SCRIPT: script },
			encoding: "utf8",
			windowsHide: true,
		});
		expect(`${parsed.stdout}${parsed.stderr}`.trim()).toBe("");
		expect(parsed.status).toBe(0);
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

	it("upgrades Bun with the absolute bun path, which replaces itself even while it runs (Windows included)", () => {
		expect(buildPlan("bun", "bun-upgrade", win)?.spawn).toEqual({ file: win.bun, args: ["upgrade"], shell: false });
		expect(buildPlan("bun", "bun-upgrade", mac)?.command).toBe(`"${mac.bun}" upgrade`);
		expect(buildPlan("bun", "bun-upgrade", { ...mac, bun: null })).toBeNull();
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

	it("has main download the pinned PortableGit, re-checks its published SHA-256, and extracts it without admin", () => {
		const plan = buildPlan("git", "portable-git", win);
		expect(plan?.prompt).toBeNull();
		expect(plan?.location).toBe(join(win.toolsDir, "git"));
		const file = join(win.toolsDir, ".downloads", "PortableGit-2.56.0.2-64-bit.7z.exe");
		expect(plan?.download).toEqual({ url: PORTABLE_GIT.x64.url, sha256: PORTABLE_GIT.x64.sha256, file });
		const script = decodePowerShell(plan?.spawn.args ?? []);
		expect(plan?.command).toBe(script);
		// The shown command names what main downloaded; the script itself never fetches.
		expect(script.split("\n")[0]).toBe(
			`# OMPdesk downloaded ${PORTABLE_GIT.x64.url} (SHA-256 ${PORTABLE_GIT.x64.sha256}) to ${file}`,
		);
		expect(script).not.toMatch(/Invoke-WebRequest|ProgressPreference/);
		expect(script).toContain(`$file = '${file}'`);
		expect(script).toContain("Get-FileHash -Algorithm SHA256");
		expect(script.indexOf("Get-FileHash")).toBeLessThan(script.indexOf("Start-Process"));
		expect(script).toContain(`$dest = '${join(win.toolsDir, "git")}'`);
		expect(script).not.toMatch(/RunAs|winget/);
		const arm = buildPlan("git", "portable-git", { ...win, arch: "arm64" });
		expect(arm?.download?.sha256).toBe(PORTABLE_GIT.arm64.sha256);
		expect(decodePowerShell(arm?.spawn.args ?? [])).toContain(PORTABLE_GIT.arm64.sha256);
		// A quote in the profile path cannot end the PowerShell string.
		const quoted = decodePowerShell(
			buildPlan("git", "portable-git", { ...win, toolsDir: "C:\\Users\\O'Brien\\tools" })?.spawn.args ?? [],
		);
		expect(quoted).toContain(`'${join("C:\\Users\\O''Brien\\tools", "git")}'`);
	});

	it("downloads nothing itself for the other methods", () => {
		expect(buildPlan("bun", "bun-script", win)?.download).toBeNull();
		expect(buildPlan("omp", "bun-global", mac)?.download).toBeNull();
		expect(buildPlan("gh", "brew", mac)?.download).toBeNull();
		expect(buildPlan("gh", "winget", win)?.download).toBeNull();
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

	it("unpacks an archive main downloaded into the managed tools dir only after its SHA-256 matched", () => {
		const release: ArchiveRelease = {
			item: "node",
			version: "v24.11.0",
			file: "node-v24.11.0-darwin-arm64.tar.gz",
			url: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.gz",
			sha256: "a".repeat(64),
		};
		expect(buildPlan("node", "archive", mac)).toBeNull();
		const plan = buildPlan("node", "archive", mac, release);
		// Built with the host's path module: a darwin plan only ever runs on a Mac, but this suite also runs on Windows.
		const file = join("/data/tools", ".downloads", "node-v24.11.0-darwin-arm64.tar.gz");
		expect(plan?.download).toEqual({ url: release.url, sha256: release.sha256, file });
		const script = plan?.spawn.args[1] ?? "";
		expect(plan?.command).toBe(script);
		expect(plan?.location).toBe(join("/data/tools", "node"));
		expect(script.split("\n")[0]).toBe(`# OMPdesk downloaded ${release.url} (SHA-256 ${release.sha256}) to ${file}`);
		expect(script).toContain("set -euo pipefail");
		expect(script).not.toContain("curl");
		const verify = script.indexOf("shasum -a 256 -c -");
		expect(verify).toBeGreaterThan(0);
		expect(script.indexOf("tar -xzf")).toBeGreaterThan(verify);
		expect(script.indexOf("mv ")).toBeGreaterThan(verify);
		expect(script).toContain(`echo '${"a".repeat(64)}  ${file}' | shasum -a 256 -c -`);
		expect(buildPlan("gh", "archive", mac, release)).toBeNull();
	});
});

describe("manualSteps", () => {
	it("gives the per-platform command and the official page", () => {
		expect(manualSteps("git", "darwin").commands).toEqual(["xcode-select --install"]);
		expect(manualSteps("node", "win32")).toEqual({
			commands: ["winget install --id OpenJS.NodeJS.LTS -e"],
			url: "https://nodejs.org/en/download",
		});
	});

	it("asks nobody to run a command for Bun or omp: OMPdesk repairs those itself", () => {
		for (const platform of ["darwin", "win32"] as const) {
			expect(manualSteps("bun", platform)).toEqual({ commands: [], url: "" });
			expect(manualSteps("omp", platform)).toEqual({ commands: [], url: "" });
		}
	});
});

describe("agent-desktop plans", () => {
	const release: ArchiveRelease = {
		item: "agent-desktop",
		version: "1.2.0",
		file: "agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz",
		url: "https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz",
		sha256: "a".repeat(64),
	};
	const winRelease: ArchiveRelease = {
		...release,
		file: "agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz",
		url: "https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz",
		sha256: "b".repeat(64),
	};

	it("installs on macOS and Windows on its own, replaces a missing, outdated or broken copy, and has no build for other CPUs", () => {
		const outdatedCopy: SetupPresence = { kind: "outdated", version: "1.1.0", minimum: "1.2.0", path: "/x" };
		const broken: SetupPresence = { kind: "broken", detail: "x", path: "/x" };
		for (const ctx of [mac, win, { ...mac, brew: null }, { ...win, winget: null }, { ...win, arch: "arm64" }]) {
			for (const presence of [missing, outdatedCopy, broken]) {
				expect(selectMethod("agent-desktop", presence, ctx)).toBe("agent-desktop-archive");
			}
			expect(selectMethod("agent-desktop", present, ctx)).toBeNull();
		}
		expect(selectMethod("agent-desktop", missing, { ...win, arch: "ia32" })).toBeNull();
		expect(selectMethod("agent-desktop", missing, { ...mac, platform: "other" })).toBeNull();
	});

	it("points at the release page and asks for no command: OMPdesk installs it itself", () => {
		expect(manualSteps("agent-desktop", "darwin")).toEqual({
			commands: [],
			url: "https://github.com/vercel-labs/agent-desktop/releases",
		});
	});

	it("needs the release it downloaded, and no other item's", () => {
		expect(buildPlan("agent-desktop", "agent-desktop-archive", mac)).toBeNull();
		expect(buildPlan("gh", "agent-desktop-archive", mac, release)).toBeNull();
		expect(buildPlan("agent-desktop", "archive", mac, release)).toBeNull();
		expect(buildPlan("agent-desktop", "agent-desktop-archive", { ...mac, platform: "other" }, release)).toBeNull();
	});

	it("on macOS checks the hash and the archive's exact contents before it replaces the old folder, then asks the new CLI for its version", () => {
		const plan = buildPlan("agent-desktop", "agent-desktop-archive", mac, release);
		const file = join("/data/tools", ".downloads", release.file);
		expect(plan?.download).toEqual({ url: release.url, sha256: release.sha256, file });
		expect(plan?.location).toBe(join("/data/tools", "agent-desktop"));
		expect(plan?.spawn.file).toBe("/bin/bash");
		const script = plan?.spawn.args[1] ?? "";
		expect(plan?.command).toBe(script);
		expect(script.split("\n")[0]).toBe(`# OMPdesk downloaded ${release.url} (SHA-256 ${release.sha256}) to ${file}`);
		expect(script).toContain("set -euo pipefail");
		expect(script).not.toContain("curl");
		const order = [
			`echo '${"a".repeat(64)}  ${file}' | shasum -a 256 -c -`,
			"tar -tzf",
			"'agent-desktop agent-desktop-macos-helper'",
			"tar -xzf",
			"[ -L ",
			"chmod 755",
			'"$tmp/new/agent-desktop" --version',
			'mv "$dest" "$tmp/old"',
			'mv "$tmp/new" "$dest"',
			'"$dest/agent-desktop" --version',
		].map(part => {
			const at = script.indexOf(part);
			expect(at, part).toBeGreaterThan(0);
			return at;
		});
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(script).toContain(`want='agent-desktop 1.2.0'`);
		expect(script).toContain(`dest='${join("/data/tools", "agent-desktop")}'`);
	});

	it("on Windows checks the hash and tar.exe's listing, moves a running exe aside, and puts it back when the new one fails", () => {
		const plan = buildPlan("agent-desktop", "agent-desktop-archive", win, winRelease);
		const script = plan?.command ?? "";
		expect(decodePowerShell(plan?.spawn.args ?? [])).toBe(script);
		expect(plan?.spawn.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		expect(plan?.location).toBe(join(win.toolsDir, "agent-desktop"));
		expect(plan?.download?.sha256).toBe(winRelease.sha256);
		const lines = script.split("\n");
		expect(lines[0]).toContain(`(SHA-256 ${winRelease.sha256})`);
		const at = (part: string) => {
			const index = lines.findIndex(line => line.includes(part));
			expect(index, part).toBeGreaterThanOrEqual(0);
			return index;
		};
		const order = [
			"Get-FileHash -Algorithm SHA256",
			"$env:SystemRoot 'System32\\tar.exe'",
			"-ne 'agent-desktop.exe'",
			"& $tar -xzf $file -C $part",
			"$aside = $exe + '.ompdesk-' + [DateTime]::UtcNow.Ticks",
			"Move-Item -LiteralPath $new -Destination $exe",
			"& $exe --version",
		].map(at);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		// A failed --version puts the old exe back, after the check.
		const restore = lines.findLastIndex(line => line.includes("Move-Item -LiteralPath $aside -Destination $exe"));
		expect(restore).toBeGreaterThan(order.at(-1) ?? 0);
		expect(script).toContain("Get-ChildItem -Path ($exe + '.ompdesk-*') -ErrorAction SilentlyContinue | Remove-Item");
		expect(script).toContain("$want = 'agent-desktop 1.2.0'");
		expect(script).toContain("Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue");
	});

	describe.runIf(process.platform === "darwin")("the macOS script, run", () => {
		const roots: string[] = [];
		afterEach(() => {
			for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		});

		/** A release archive holding `entries` (name → content), put where setup downloads it; `run` runs the plan's script. */
		function stage(entries: Record<string, string>) {
			const root = mkdtempSync(join(tmpdir(), "ompdesk-agent-desktop-"));
			roots.push(root);
			const tools = join(root, "tools");
			const source = join(root, "source");
			mkdirSync(tools);
			mkdirSync(source);
			for (const [name, content] of Object.entries(entries)) {
				writeFileSync(join(source, name), content);
				chmodSync(join(source, name), 0o755);
			}
			const archive = join(root, "release.tar.gz");
			expect(spawnSync("tar", ["-czf", archive, "-C", source, ...Object.keys(entries)]).status).toBe(0);
			const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
			const plan = buildPlan(
				"agent-desktop",
				"agent-desktop-archive",
				{ ...mac, toolsDir: tools },
				{ ...release, sha256 },
			);
			const downloaded = plan?.download?.file ?? "";
			mkdirSync(dirname(downloaded), { recursive: true });
			copyFileSync(archive, downloaded);
			const script = plan?.command ?? "";
			return {
				tools,
				dest: join(tools, "agent-desktop"),
				run: () => spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" }),
			};
		}
		const cli = (version: string) => `#!/bin/sh\necho "agent-desktop ${version}"\n`;
		const GOOD = { "agent-desktop": cli("1.2.0"), "agent-desktop-macos-helper": "#!/bin/sh\n" };

		it("installs the CLI with its helper beside it, prints its version, and leaves nothing else in the tools dir", () => {
			const { tools, dest, run } = stage(GOOD);
			const result = run();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("agent-desktop 1.2.0 is in");
			expect(readdirSync(dest).sort()).toEqual(["agent-desktop", "agent-desktop-macos-helper"]);
			expect(spawnSync(join(dest, "agent-desktop"), ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(
				"agent-desktop 1.2.0",
			);
			expect(readdirSync(tools).sort()).toEqual([".downloads", "agent-desktop"]);
		});

		it("replaces an installed copy by moving the new folder in", () => {
			const { dest, run } = stage(GOOD);
			mkdirSync(dest);
			writeFileSync(join(dest, "agent-desktop"), cli("1.1.0"));
			writeFileSync(join(dest, "stale-file"), "left by an older release");
			const result = run();
			expect(result.status, result.stderr).toBe(0);
			expect(readdirSync(dest).sort()).toEqual(["agent-desktop", "agent-desktop-macos-helper"]);
		});

		it("touches nothing when the archive holds more than the CLI and its helper, or a CLI that prints another version", () => {
			for (const entries of [
				{ ...GOOD, "install.sh": "#!/bin/sh\n" },
				{ ...GOOD, "agent-desktop": cli("1.1.0") },
			]) {
				const { tools, dest, run } = stage(entries);
				mkdirSync(dest);
				writeFileSync(join(dest, "agent-desktop"), cli("1.1.5"));
				const result = run();
				expect(result.status).not.toBe(0);
				expect(readFileSync(join(dest, "agent-desktop"), "utf8")).toBe(cli("1.1.5"));
				expect(readdirSync(tools).filter(name => name.startsWith(".agent-desktop."))).toEqual([]);
				expect(existsSync(join(dest, "agent-desktop-macos-helper"))).toBe(false);
			}
		});
	});
});

describe("Tailscale plans", () => {
	const zip: TailscaleRelease = {
		version: "1.104.1",
		file: "Tailscale-1.104.1-macos.zip",
		url: "https://pkgs.tailscale.com/stable/Tailscale-1.104.1-macos.zip",
		sha256: "c9acf3b55335f1fd7cbc52b515b1bbf33076018ae74b91a2476d96b0b7511e72",
	};
	const msi: TailscaleRelease = {
		version: "1.104.1",
		file: "tailscale-setup-1.104.1-amd64.msi",
		url: "https://pkgs.tailscale.com/stable/tailscale-setup-1.104.1-amd64.msi",
		sha256: "f".repeat(64),
	};

	it("picks the signed zip on macOS, winget on Windows, and the MSI only for an architecture it has one for", () => {
		expect(selectMethod("tailscale", missing, mac)).toBe("tailscale-zip");
		expect(selectMethod("tailscale", missing, { ...mac, brew: null })).toBe("tailscale-zip");
		expect(selectMethod("tailscale", missing, win)).toBe("winget");
		expect(selectMethod("tailscale", missing, { ...win, winget: null })).toBe("tailscale-msi");
		expect(selectMethod("tailscale", missing, { ...win, winget: null, arch: "ia32" })).toBe("tailscale-msi");
		expect(selectMethod("tailscale", missing, { ...win, winget: null, arch: "riscv64" })).toBeNull();
		expect(selectMethod("tailscale", present, mac)).toBeNull();
		expect(selectMethod("tailscale", missing, { ...mac, platform: "other" })).toBeNull();
	});

	it("maps the machine's architecture to the index's MSI names", () => {
		expect([
			tailscaleMsiArch("x64"),
			tailscaleMsiArch("arm64"),
			tailscaleMsiArch("ia32"),
			tailscaleMsiArch("ppc"),
		]).toEqual(["amd64", "arm64", "x86", null]);
	});

	it("downloads the zip in main with its published hash, then checks it again, its signature, bundle id and team before copying", () => {
		const plan = buildPlan("tailscale", "tailscale-zip", mac, undefined, zip);
		expect(plan).toMatchObject({
			item: "tailscale",
			method: "tailscale-zip",
			prompt: null,
			location: "/Applications/Tailscale.app",
			download: { url: zip.url, sha256: zip.sha256, file: join("/data/tools", ".downloads", zip.file) },
			spawn: { file: "/bin/bash", shell: false },
		});
		const script = plan?.spawn.args[1] ?? "";
		const order = [
			"shasum -a 256 -c -",
			"ditto -x -k",
			'codesign --verify --deep --strict "$app"',
			"PlistBuddy",
			"io.tailscale.ipn.macsys|io.tailscale.ipn.macos",
			"TeamIdentifier=",
			"W5364U7YZB",
			"ditto \"$app\" '/Applications/Tailscale.app'",
		].map(part => script.indexOf(part));
		expect(order.every(index => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(script).toContain("set -euo pipefail");
		expect(script).toContain(zip.sha256);
		expect(plan?.command).toBe(script);
		expect(buildPlan("tailscale", "tailscale-zip", mac)).toBeNull();
		expect(buildPlan("tailscale", "tailscale-zip", mac, undefined, msi)).toBeNull();
	});

	it("verifies the MSI's hash and a Valid Tailscale Inc. signature before an elevated msiexec, without TS_NOLAUNCH", () => {
		const plan = buildPlan("tailscale", "tailscale-msi", win, undefined, msi);
		expect(plan).toMatchObject({
			method: "tailscale-msi",
			prompt: "uac",
			location: "C:\\Program Files\\Tailscale",
			download: { url: msi.url, sha256: msi.sha256 },
		});
		expect(plan?.spawn.file).toContain("powershell.exe");
		const script = decodePowerShell(plan?.spawn.args ?? []);
		const order = [
			"Get-FileHash -Algorithm SHA256",
			`SHA-256 mismatch: expected ${msi.sha256}`,
			"Get-AuthenticodeSignature",
			"-ne 'Valid'",
			"*CN=Tailscale Inc.*",
			"msiexec.exe",
		].map(part => script.indexOf(part));
		expect(order.every(index => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(script).toContain("-Verb RunAs");
		expect(script).toContain("'/qn'");
		expect(script).toContain("-ne 3010");
		expect(script).not.toContain("TS_NOLAUNCH");
		expect(buildPlan("tailscale", "tailscale-msi", win)).toBeNull();
		expect(buildPlan("tailscale", "tailscale-msi", win, undefined, zip)).toBeNull();
	});

	it("runs winget silently with its own agreements, elevated", () => {
		const plan = buildPlan("tailscale", "winget", win);
		expect(plan?.spawn.args).toEqual([
			"install",
			"--id",
			"Tailscale.Tailscale",
			"-e",
			"--silent",
			"--accept-package-agreements",
			"--accept-source-agreements",
		]);
		expect(plan).toMatchObject({ prompt: "uac", location: "C:\\Program Files\\Tailscale", download: null });
		expect(buildPlan("tailscale", "winget", { ...win, winget: null })).toBeNull();
		// The other winget items keep their own arguments.
		expect(buildPlan("gh", "winget", win)?.spawn.args).not.toContain("--silent");
	});

	it("points at tailscale.com/download when it has to be done by hand", () => {
		expect(manualSteps("tailscale", "darwin")).toEqual({
			commands: ["brew install --cask tailscale-app"],
			url: "https://tailscale.com/download",
		});
		expect(manualSteps("tailscale", "win32").commands).toEqual(["winget install --id Tailscale.Tailscale -e"]);
	});
});
