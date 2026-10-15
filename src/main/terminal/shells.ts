/**
 * Shells a Terminal panel tab can start (C103/C104): this computer's login
 * shells on macOS (`/etc/shells` that exist, the user's `$SHELL` first), and on
 * Windows PowerShell, PowerShell 7, Command Prompt and Git Bash where present.
 * The renderer names one by `path`; main starts only a path from this list.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { TerminalShell } from "../../shared/terminal-types";

export interface ShellProbe {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	exists: (file: string) => boolean;
	readEtcShells: () => string;
}

const LIVE: ShellProbe = {
	platform: process.platform,
	env: process.env,
	exists: existsSync,
	readEtcShells: () => {
		try {
			return readFileSync("/etc/shells", "utf8");
		} catch {
			return "";
		}
	},
};

/** The default shell first; each path once. */
export function detectShells(probe: ShellProbe = LIVE): TerminalShell[] {
	const found: TerminalShell[] = [];
	const add = (file: string | undefined, name: string, args: string[]) => {
		if (!file || !probe.exists(file) || found.some(shell => shell.path.toLowerCase() === file.toLowerCase())) return;
		found.push({ path: file, name, args });
	};
	if (probe.platform === "win32") {
		const root = probe.env.SystemRoot ?? "C:\\Windows";
		const programs = probe.env.ProgramFiles ?? "C:\\Program Files";
		add(probe.env.ComSpec ?? path.win32.join(root, "System32", "cmd.exe"), "Command Prompt", []);
		add(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "Windows PowerShell", [
			"-NoLogo",
		]);
		add(path.win32.join(programs, "PowerShell", "7", "pwsh.exe"), "PowerShell 7", ["-NoLogo"]);
		for (const bash of [
			path.win32.join(programs, "Git", "bin", "bash.exe"),
			probe.env.LOCALAPPDATA &&
				path.win32.join(probe.env.LOCALAPPDATA, "ompdesk", "tools", "git", "bin", "bash.exe"),
		])
			if (bash) add(bash, "Git Bash", ["--login", "-i"]);
		return found;
	}
	const listed = probe
		.readEtcShells()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.startsWith("/"));
	for (const file of [probe.env.SHELL, ...listed, "/bin/zsh", "/bin/bash"])
		if (file) add(file, path.posix.basename(file), ["-l"]);
	return found;
}
