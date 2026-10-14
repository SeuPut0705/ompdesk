/**
 * Install plans: for each setup item, the one way this machine installs it and
 * the exact process that runs. Everything here is fixed by main; the renderer
 * can name an item, never a command.
 */
import { join } from "node:path";
import type { SetupItemId, SetupMethod, SetupPlatform, SetupPresence } from "../../shared/setup";
import { ompNeedsShell, ompSpawnArgs, ompSpawnCommand } from "../omp-runtime";
import { managedGitRoot } from "./paths";

export const OMP_PACKAGE = "@oh-my-pi/pi-coding-agent";

/**
 * Git for Windows' PortableGit, pinned with the SHA-256 its release notes
 * publish (v2.56.0.windows.2). Raise both together.
 */
export const PORTABLE_GIT = {
	version: "2.56.0.2",
	x64: {
		url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe",
		sha256: "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b",
	},
	arm64: {
		url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-arm64.7z.exe",
		sha256: "0f21e681bd33e006e0348dfa1a2be6769efd77e3bfdb247320314facde23a46c",
	},
} as const;

export const WINGET_IDS = { git: "Git.Git", gh: "GitHub.cli", node: "OpenJS.NodeJS.LTS" } as const;

/** A downloaded release for an `archive` install (macOS without Homebrew): URL and its published SHA-256. */
export interface ArchiveRelease {
	item: "gh" | "node";
	version: string;
	file: string;
	url: string;
	sha256: string;
}

export interface PlanContext {
	platform: SetupPlatform;
	arch: string;
	/** Where Bun lives (BUN_INSTALL or ~/.bun). */
	bunInstall: string;
	toolsDir: string;
	/** Detected executables; null when absent. */
	bun: string | null;
	omp: string | null;
	brew: string | null;
	winget: string | null;
	/** Windows: `%SystemRoot%`. */
	systemRoot: string;
}

export interface SpawnSpec {
	file: string;
	args: string[];
	/** Only for a Windows `.cmd` shim; args are then already quoted for cmd.exe. */
	shell: boolean;
}

export interface InstallPlan {
	item: SetupItemId;
	method: SetupMethod;
	spawn: SpawnSpec;
	/** The command as shown to the user. */
	command: string;
	location: string;
	prompt: "uac" | "dialog" | null;
}

/** How `item` installs here, or null when nothing can install it automatically. */
export function selectMethod(item: SetupItemId, presence: SetupPresence, ctx: PlanContext): SetupMethod | null {
	if (presence.kind === "present" || ctx.platform === "other") return null;
	const mac = ctx.platform === "darwin";
	switch (item) {
		case "bun":
			return "bun-script";
		case "omp":
			return presence.kind === "outdated" && ctx.omp ? "omp-update" : "bun-global";
		case "git":
			return mac ? "xcode-select" : "portable-git";
		case "gh":
		case "node":
			if (mac) return ctx.brew ? "brew" : "archive";
			return ctx.winget ? "winget" : null;
	}
}

/** POSIX single-quoted shell word. */
export function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted string. */
export function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function powershell(ctx: PlanContext): string {
	return join(ctx.systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** `-EncodedCommand` (UTF-16LE base64): the script reaches PowerShell without any command-line quoting. */
function powershellScript(ctx: PlanContext, script: string): SpawnSpec {
	return {
		file: powershell(ctx),
		args: [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		shell: false,
	};
}

/** Download, verify and extract PortableGit into `<tools>\git`, replacing a previous copy only once the new one is complete. */
export function portableGitScript(dest: string, arch: string): string {
	const pin = arch === "arm64" ? PORTABLE_GIT.arm64 : PORTABLE_GIT.x64;
	return [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		"[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
		`$dest = ${psQuote(dest)}`,
		"$part = $dest + '.partial'",
		"$tmp = Join-Path ([IO.Path]::GetTempPath()) ('ompdesk-git-' + [guid]::NewGuid())",
		"New-Item -ItemType Directory -Force -Path $tmp | Out-Null",
		"try {",
		"  $file = Join-Path $tmp 'PortableGit.7z.exe'",
		`  Write-Output ('Downloading ' + ${psQuote(pin.url)})`,
		`  Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(pin.url)} -OutFile $file`,
		"  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()",
		`  if ($hash -ne ${psQuote(pin.sha256)}) { throw ('SHA-256 mismatch: expected ${pin.sha256}, got ' + $hash) }`,
		"  Write-Output 'SHA-256 verified'",
		"  if (Test-Path -LiteralPath $part) { Remove-Item -Recurse -Force -LiteralPath $part }",
		"  $proc = Start-Process -FilePath $file -ArgumentList @('-y', ('-o\"' + $part + '\"')) -Wait -PassThru -WindowStyle Hidden",
		"  if ($proc.ExitCode -ne 0) { throw ('PortableGit extraction exited with ' + $proc.ExitCode) }",
		"  if (-not (Test-Path -LiteralPath (Join-Path $part 'bin\\bash.exe'))) { throw 'bash.exe is missing after extraction' }",
		"  if (Test-Path -LiteralPath $dest) { Remove-Item -Recurse -Force -LiteralPath $dest }",
		"  Move-Item -LiteralPath $part -Destination $dest",
		"  Write-Output ('Git for Windows ' + " + psQuote(PORTABLE_GIT.version) + " + ' is in ' + $dest)",
		"} finally {",
		"  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue",
		"}",
	].join("\n");
}

/** Download `release`, check its SHA-256, and unpack it into `<tools>/<item>` (bash, macOS). */
export function archiveScript(release: ArchiveRelease, toolsDir: string): string {
	const dest = join(toolsDir, release.item);
	const unpack =
		release.item === "node"
			? `tar -xzf "$tmp/archive" -C "$tmp/x" --strip-components 1`
			: // gh's zip holds one gh_<version>_macOS_<arch>/ directory.
				`ditto -x -k "$tmp/archive" "$tmp/zip" && mv "$tmp"/zip/*/* "$tmp/x/"`;
	return [
		"set -euo pipefail",
		'tmp="$(mktemp -d)"',
		`trap 'rm -rf "$tmp"' EXIT`,
		'mkdir -p "$tmp/x" "$tmp/zip"',
		`echo "Downloading ${release.url}"`,
		`curl -fL --retry 2 --proto '=https' -o "$tmp/archive" ${shQuote(release.url)}`,
		`echo ${shQuote(`${release.sha256}  `)}"$tmp/archive" | shasum -a 256 -c -`,
		unpack,
		`mkdir -p ${shQuote(toolsDir)}`,
		`rm -rf ${shQuote(dest)}`,
		`mv "$tmp/x" ${shQuote(dest)}`,
		`echo ${shQuote(`${release.item} ${release.version} is in ${dest}`)}`,
	].join("\n");
}

/**
 * The plan for `method`. `release` is required for `archive`. Null when the
 * plan cannot run: omp without Bun, a method this context lacks the tool for.
 */
export function buildPlan(
	item: SetupItemId,
	method: SetupMethod,
	ctx: PlanContext,
	release?: ArchiveRelease,
): InstallPlan | null {
	const win = ctx.platform === "win32";
	switch (method) {
		case "bun-script":
			return win
				? {
						item,
						method,
						spawn: {
							file: powershell(ctx),
							args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm bun.sh/install.ps1 | iex"],
							shell: false,
						},
						command: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"',
						location: ctx.bunInstall,
						prompt: null,
					}
				: {
						item,
						method,
						spawn: {
							file: "/bin/bash",
							args: ["-c", "set -o pipefail; curl -fsSL https://bun.sh/install | bash"],
							shell: false,
						},
						command: "curl -fsSL https://bun.sh/install | bash",
						location: ctx.bunInstall,
						prompt: null,
					};
		case "bun-global":
			if (!ctx.bun) return null;
			return {
				item,
				method,
				spawn: { file: ctx.bun, args: ["install", "-g", OMP_PACKAGE], shell: false },
				command: `"${ctx.bun}" install -g ${OMP_PACKAGE}`,
				location: join(ctx.bunInstall, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent"),
				prompt: null,
			};
		case "omp-update":
			if (!ctx.omp) return null;
			return {
				item,
				method,
				spawn: {
					file: ompSpawnCommand(ctx.omp, win ? "win32" : "darwin"),
					args: ompSpawnArgs(ctx.omp, ["update"], win ? "win32" : "darwin"),
					shell: ompNeedsShell(ctx.omp, win ? "win32" : "darwin"),
				},
				command: `"${ctx.omp}" update`,
				location: ctx.omp,
				prompt: null,
			};
		case "portable-git": {
			const dest = managedGitRoot(ctx.toolsDir);
			const script = portableGitScript(dest, ctx.arch);
			return { item, method, spawn: powershellScript(ctx, script), command: script, location: dest, prompt: null };
		}
		case "xcode-select":
			return {
				item,
				method,
				spawn: { file: "/usr/bin/xcode-select", args: ["--install"], shell: false },
				command: "xcode-select --install",
				location: "/Library/Developer/CommandLineTools",
				prompt: "dialog",
			};
		case "brew": {
			if (!ctx.brew) return null;
			const formula = item === "gh" ? "gh" : "node";
			return {
				item,
				method,
				spawn: { file: ctx.brew, args: ["install", formula], shell: false },
				command: `"${ctx.brew}" install ${formula}`,
				location: join(ctx.brew, "..", ".."),
				prompt: null,
			};
		}
		case "winget": {
			if (!ctx.winget || (item !== "git" && item !== "gh" && item !== "node")) return null;
			const args = [
				"install",
				"--id",
				WINGET_IDS[item],
				"-e",
				"--accept-source-agreements",
				"--accept-package-agreements",
			];
			return {
				item,
				method,
				spawn: { file: ctx.winget, args, shell: false },
				command: `winget ${args.join(" ")}`,
				location: item === "node" ? "C:\\Program Files\\nodejs" : "C:\\Program Files",
				prompt: "uac",
			};
		}
		case "archive": {
			if (!release || release.item !== item) return null;
			const script = archiveScript(release, ctx.toolsDir);
			return {
				item,
				method,
				spawn: { file: "/bin/bash", args: ["-c", script], shell: false },
				command: script,
				location: join(ctx.toolsDir, release.item),
				prompt: null,
			};
		}
	}
}

const MANUAL_URLS: Record<SetupItemId, string> = {
	bun: "https://bun.sh/docs/installation",
	omp: "https://github.com/can1357/oh-my-pi",
	git: "https://git-scm.com/downloads",
	gh: "https://cli.github.com/",
	node: "https://nodejs.org/en/download",
};

/** What to run by hand, and the official page, when the automatic install keeps failing. */
export function manualSteps(
	item: SetupItemId,
	presence: SetupPresence | null,
	platform: SetupPlatform,
): { commands: string[]; url: string } {
	const win = platform === "win32";
	const url = MANUAL_URLS[item];
	switch (item) {
		case "bun":
			return {
				commands: [
					win ? 'powershell -c "irm bun.sh/install.ps1 | iex"' : "curl -fsSL https://bun.sh/install | bash",
				],
				url,
			};
		case "omp":
			return { commands: [presence?.kind === "outdated" ? "omp update" : `bun install -g ${OMP_PACKAGE}`], url };
		case "git":
			return { commands: [win ? `winget install --id ${WINGET_IDS.git} -e` : "xcode-select --install"], url };
		case "gh":
		case "node":
			return {
				commands: [
					win ? `winget install --id ${WINGET_IDS[item]} -e` : `brew install ${item === "gh" ? "gh" : "node"}`,
				],
				url,
			};
	}
}
