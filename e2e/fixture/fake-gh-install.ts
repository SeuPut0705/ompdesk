/**
 * Install the fake GitHub CLI (`src/main/github-auth/test-fake-gh.ts`) as `gh` on a PATH directory, the way the
 * platform starts a tool it finds there. POSIX runs the script by its shebang. Windows starts a tool found on
 * PATH only as `gh.exe` (`resolveBin` in `src/main/local/git/exec.ts`), never as a bare script or a `.cmd` shim,
 * so bun compiles the script into one (about 0.5 s, 96 MB beside the bun runtime it embeds).
 *
 *     const ghDir = await fixtureGhDir(root);
 *     const env = { ...process.env, PATH: [ghDir, process.env.PATH].join(path.delimiter) };
 */
import { execFile } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeFakeGh } from "../../src/main/github-auth/test-fake-gh";
import { findOnPath, launcherNames, needsShell, spawnArgs, spawnCommand } from "../../src/main/spawn";

export async function fixtureGhDir(root: string): Promise<string> {
	const script = await writeFakeGh(root);
	const dir = dirname(script);
	if (process.platform !== "win32") return dir;
	const bun = findOnPath(launcherNames("bun", "win32"), process.env.PATH ?? "", "win32");
	if (!bun) throw new Error("bun is not on PATH: it compiles the fake gh into gh.exe");
	// An entry with no extension is bundled as a data file, not run: bun compiles the script as `gh.js`.
	const source = join(dir, "gh.js");
	await copyFile(script, source);
	const args = ["build", "--compile", source, "--outfile", join(dir, "gh.exe")];
	await promisify(execFile)(spawnCommand(bun, "win32"), spawnArgs(bun, args, "win32"), {
		shell: needsShell(bun, "win32"),
		windowsHide: true,
	});
	return dir;
}
