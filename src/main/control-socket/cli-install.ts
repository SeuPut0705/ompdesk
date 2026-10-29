/**
 * The `ompdesk` command on PATH: a launcher in the app's own `bin` folder (reaches every process OMPdesk spawns,
 * terminals included) and, in the packaged app, one in Bun's global bin folder next to `omp`, so a terminal outside
 * OMPdesk finds it too. The launcher runs the CLI (`resources/cli/ompdesk.ts`) with bun.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SetupPlatform } from "../../shared/setup";
import { writeFileAtomicSync } from "../atomic-file";
import { bunInstallDir, mergePathLists } from "../setup/paths";

export const LAUNCHER_MARKER = "ompdesk CLI launcher, written by OMPdesk";

export interface CliInstallOptions {
	/** The folder holding `ompdesk.ts`. */
	cliDir: string;
	userData: string;
	platform: SetupPlatform;
	packaged: boolean;
	/** Read for `BUN_INSTALL` and `OMP_GUI_HEADLESS`; its PATH gets the launcher folder appended. */
	env: NodeJS.ProcessEnv;
	home: string;
}

const shQuote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;

function posixLauncher(script: string, bunBin: string, platform: SetupPlatform): string {
	// Git Bash on Windows: Bun's own executable by its absolute path (a `C:\…` PATH entry would split at its colon).
	const run =
		platform === "win32" ? `exec ${shQuote(join(bunBin, "bun.exe"))}` : `PATH=${shQuote(bunBin)}":$PATH" exec bun`;
	return `#!/bin/sh\n# ${LAUNCHER_MARKER}\n${run} ${shQuote(script)} "$@"\n`;
}

/** cmd.exe looks in the current folder before PATH: a bare `bun` would run a `bun.exe` the folder holds. */
function cmdLauncher(script: string, bunBin: string): string {
	return ["@echo off", `rem ${LAUNCHER_MARKER}`, `"${join(bunBin, "bun.exe")}" "${script}" %*`, ""].join("\r\n");
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
	const { cliDir, userData, platform, packaged, env, home } = options;
	const script = join(cliDir, "ompdesk.ts");
	const bunBin = join(bunInstallDir(env, home), "bin");
	const appBin = join(userData, "bin");

	const files = (dir: string, foreignWins: boolean): boolean => {
		const ok = [place(join(dir, "ompdesk"), posixLauncher(script, bunBin, platform), foreignWins)];
		if (platform === "win32") ok.push(place(join(dir, "ompdesk.cmd"), cmdLauncher(script, bunBin), foreignWins));
		return ok.every(Boolean);
	};

	const written: string[] = [];
	if (files(appBin, false)) written.push(appBin);
	env.PATH = mergePathLists(env.PATH ?? "", [appBin], platform);

	if (packaged && env.OMP_GUI_HEADLESS !== "1" && existsSync(bunBin) && files(bunBin, true)) written.push(bunBin);
	return written;
}
