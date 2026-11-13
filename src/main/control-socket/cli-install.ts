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

function posixLauncher(binary: string): string {
	return `#!/bin/sh\n# ${LAUNCHER_MARKER}\nexec ${shQuote(binary)} "$@"\n`;
}

/**
 * The sh launcher on Windows, run by Git Bash, MSYS, omp's own bash and WSL. The path is written with forward slashes:
 * Git Bash and MSYS resolve `C:/…` and `C:\…` alike, omp's bash (every agent's `ompdesk check`) only the former. Under
 * WSL the path is mapped with `wslpath`, and `run --heavy` takes the slot through the Windows CLI's `heavy hold` and
 * runs the command itself, as a Linux process (the CLI's own `run` would start it as a Windows one). The hold ends when
 * this shell does (its stdin, fd 3 here, closes), killed included; the command does not inherit it. `heavy hold`
 * answers `held <slots> pid <its Windows pid>` (with a CR from Windows), which the command gets as `OMPDESK_HEAVY_HELD`
 * so heavy work nested in it reuses the slot, or `held reused` when an ancestor's hold already covers this run.
 * `WSLENV` carries that variable into the Windows CLI, which checks the pid.
 */
function windowsShLauncher(binary: string): string {
	return String.raw`#!/bin/sh
# ${LAUNCHER_MARKER}
exe=${shQuote(binary.replaceAll("\\", "/"))}
if [ -z "$WSL_DISTRO_NAME" ] || ! command -v wslpath >/dev/null 2>&1; then
	exec "$exe" "$@"
fi
exe=$(wslpath -u "$exe") || exit 1
case ":$WSLENV:" in
*:OMPDESK_HEAVY_HELD:*) ;;
::) WSLENV=OMPDESK_HEAVY_HELD ;;
*) WSLENV="$WSLENV:OMPDESK_HEAVY_HELD" ;;
esac
export WSLENV
if [ "$1" != run ] || [ "$2" != --heavy ]; then
	exec "$exe" "$@"
fi
shift 2
all=
if [ "$1" = --all ]; then all=--all; shift; fi
if [ "$1" = -- ]; then shift; fi
if [ $# -eq 0 ]; then exec "$exe" run --heavy $all; fi
fifos=$(mktemp -d) || exit 1
mkfifo "$fifos/in" "$fifos/out" || exit 1
"$exe" heavy hold $all <"$fifos/in" >"$fifos/out" &
hold=$!
exec 3>"$fifos/in" 4<"$fifos/out"
rm -rf "$fifos"
held=
read -r held <&4
held=$(printf '%s' "$held" | tr -d '\r')
case $held in
"held reused") ;;
"held "*" pid "*) OMPDESK_HEAVY_HELD=$(printf '%s' "$held" | sed 's/.* pid //'); export OMPDESK_HEAVY_HELD ;;
*) exec 3>&-; wait "$hold"; code=$?; [ $code -eq 0 ] && code=1; exit $code ;;
esac
"$@" 3>&- 4<&-
code=$?
exec 3>&- 4<&-
wait "$hold"
exit $code
`;
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
		const sh = platform === "win32" ? windowsShLauncher(binary) : posixLauncher(binary);
		const ok = [place(join(dir, "ompdesk"), sh, foreignWins)];
		if (platform === "win32") ok.push(place(join(dir, "ompdesk.cmd"), cmdLauncher(binary), foreignWins));
		return ok.every(Boolean);
	};

	const written: string[] = [];
	if (files(appBin, false)) written.push(appBin);
	env.PATH = mergePathLists(env.PATH ?? "", [appBin], platform);

	if (packaged && env.OMP_GUI_HEADLESS !== "1" && existsSync(bunBin) && files(bunBin, true)) written.push(bunBin);
	return written;
}
