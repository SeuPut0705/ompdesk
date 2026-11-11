/**
 * The `ompdesk` command on PATH: a launcher in the app's own `bin` folder (reaches every process OMPdesk spawns,
 * terminals included) and, in the packaged app, one in Bun's global bin folder next to `omp`, so a terminal outside
 * OMPdesk finds it too. The launcher runs the CLI the app ships (the `ompdesk` executable built from
 * `native/ompdesk/crates/cli`) by its absolute path, which moves with the app: every launch writes it again.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SetupPlatform } from "../../shared/setup";
import { writeFileAtomicSync } from "../atomic-file";
import { bunInstallDir, mergePathLists } from "../setup/paths";

export const LAUNCHER_MARKER = "ompdesk CLI launcher, written by OMPdesk";

export interface CliInstallOptions {
	/** The `ompdesk` executable (`ompdesk.exe` on Windows). */
	binary: string;
	userData: string;
	platform: SetupPlatform;
	packaged: boolean;
	/** Read for `BUN_INSTALL` and `OMP_GUI_HEADLESS`; its PATH gets the launcher folder appended. */
	env: NodeJS.ProcessEnv;
	home: string;
}

const shQuote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;

/** Also Git Bash's launcher on Windows. */
function posixLauncher(binary: string): string {
	return `#!/bin/sh\n# ${LAUNCHER_MARKER}\nexec ${shQuote(binary)} "$@"\n`;
}

/** The executable by its absolute path: cmd.exe looks in the current folder before PATH. */
function cmdLauncher(binary: string): string {
	return ["@echo off", `rem ${LAUNCHER_MARKER}`, `"${binary}" %*`, ""].join("\r\n");
}

/**
 * Writes `content` to `file` unless it already holds it; `foreignWins`: leave a file that is not ours alone. A failed
 * write (a read-only or full disk) only leaves the command missing: OMPdesk itself starts regardless.
 */
function place(file: string, content: string, foreignWins: boolean): boolean {
	try {
		if (existsSync(file)) {
			const current = readFileSync(file, "utf8");
			if (current === content) return true;
			if (foreignWins && !current.includes(LAUNCHER_MARKER)) return false;
		}
		writeFileAtomicSync(file, content, { mode: 0o755, dirMode: 0o755 });
		return true;
	} catch (error) {
		console.warn(`[cli-install] ${file}: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** Writes the launchers and puts the app's bin folder on `env.PATH`; returns the folders that now hold ours. */
export function installCliLaunchers(options: CliInstallOptions): string[] {
	const { binary, userData, platform, packaged, env, home } = options;
	const bunBin = join(bunInstallDir(env, home), "bin");
	const appBin = join(userData, "bin");

	const files = (dir: string, foreignWins: boolean): boolean => {
		const ok = [place(join(dir, "ompdesk"), posixLauncher(binary), foreignWins)];
		if (platform === "win32") ok.push(place(join(dir, "ompdesk.cmd"), cmdLauncher(binary), foreignWins));
		return ok.every(Boolean);
	};

	const written: string[] = [];
	if (files(appBin, false)) written.push(appBin);
	env.PATH = mergePathLists(env.PATH ?? "", [appBin], platform);

	if (packaged && env.OMP_GUI_HEADLESS !== "1" && existsSync(bunBin) && files(bunBin, true)) written.push(bunBin);
	return written;
}
