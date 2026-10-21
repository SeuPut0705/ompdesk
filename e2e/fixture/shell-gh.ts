/**
 * A stand-in `gh` written as a POSIX shell script, for a spec to put first on PATH (`fake-gh-install.ts` compiles a
 * JS fake instead). POSIX runs `script` through its shebang. The app spawns `gh` without a shell and looks for
 * `gh.exe`, then `gh` (src/main/local/git/exec.ts `resolveBin`): on Windows neither a shebang script nor a `.cmd`
 * runs, so `gh.exe` is a compiled launcher that hands its arguments to Git for Windows' `sh` with the same `script`,
 * which a spec writes once for both.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { baseTemp } from "../run-temp";

const LAUNCHER = `import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [file, ...head] = JSON.parse(readFileSync(join(dirname(process.execPath), "gh.argv.json"), "utf8"));
const run = spawnSync(file, [...head, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
`;

const exists = (file: string) =>
	fs.stat(file).then(
		() => true,
		() => false,
	);

/** The compiled launcher, built once per machine (a 90 MB bun runtime) and shared by every spec and worker. */
async function launcherExe(): Promise<string> {
	const dir = path.join(baseTemp(), "omp-e2e-fake-gh");
	const exe = path.join(dir, `gh-${createHash("sha256").update(LAUNCHER).digest("hex").slice(0, 12)}.exe`);
	if (await exists(exe)) return exe;
	await fs.mkdir(dir, { recursive: true });
	const own = path.join(dir, `build-${process.pid}-${Date.now()}`);
	await fs.mkdir(own);
	try {
		await fs.writeFile(path.join(own, "launcher.ts"), LAUNCHER);
		execFileSync(
			"bun",
			["build", "--compile", "--outfile", path.join(own, "gh.exe"), path.join(own, "launcher.ts")],
			{
				stdio: "ignore",
			},
		);
		// Another worker may have finished first: its exe is the same bytes, so a failed rename is not an error.
		await fs.rename(path.join(own, "gh.exe"), exe).catch(async error => {
			if (!(await exists(exe))) throw error;
		});
	} finally {
		await fs.rm(own, { recursive: true, force: true });
	}
	return exe;
}

/** Git for Windows' `sh`: `bin\sh.exe` puts `usr\bin` (cat, sed) on the script's PATH, `usr\bin\sh.exe` does not. */
function gitSh(): string {
	const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
	return path.join(execPath, "..", "..", "..", "bin", "sh.exe");
}

/** Writes `bin/gh` (POSIX) or `bin/gh.exe` (Windows) so that `gh <args>` runs `script` with those arguments. */
export async function writeShellGh(bin: string, script: string): Promise<void> {
	await fs.mkdir(bin, { recursive: true });
	if (process.platform !== "win32") {
		await fs.writeFile(path.join(bin, "gh"), script, { mode: 0o755 });
		return;
	}
	const target = path.join(bin, "gh.exe");
	const shared = await launcherExe();
	// A hard link costs nothing; another volume (OMP_GUI temp on a different drive) falls back to a copy.
	await fs.link(shared, target).catch(() => fs.copyFile(shared, target));
	await fs.writeFile(path.join(bin, "gh.sh"), script);
	await fs.writeFile(path.join(bin, "gh.argv.json"), JSON.stringify([gitSh(), path.join(bin, "gh.sh")]));
}
