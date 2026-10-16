import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLoginShellEnvCache } from "../../shell-env";
import { developerGit, findOnPath, gitRaw, resolveBin } from "./exec";

const made: string[] = [];
const savedEnv = { PATH: process.env.PATH, SHELL: process.env.SHELL };
afterEach(async () => {
	delete process.env.DEVELOPER_DIR;
	delete process.env.OMP_GUI_TEST_BREW_DIRS;
	process.env.PATH = savedEnv.PATH;
	process.env.SHELL = savedEnv.SHELL;
	resetLoginShellEnvCache();
	await Promise.all(made.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** A developer dir whose `usr/bin/git` prints a marker instead of running git. */
async function fakeDeveloperDir(): Promise<string> {
	const dir = await tempDir("omp-developer-dir-");
	await fs.mkdir(path.join(dir, "usr", "bin"), { recursive: true });
	await fs.writeFile(path.join(dir, "usr", "bin", "git"), "#!/bin/sh\necho developer-git\n", { mode: 0o755 });
	return dir;
}

describe.skipIf(process.platform === "win32")("resolveBin", () => {
	it("finds a gh that lands on PATH after an earlier lookup missed it (setup installed it while the app ran)", async () => {
		const before = await tempDir("omp-path-before-");
		const managed = await tempDir("omp-path-managed-");
		// A login shell whose PATH holds no gh, so the user's own gh never answers.
		const shell = path.join(before, "fake-shell");
		await fs.writeFile(shell, `#!/bin/sh\nexec /usr/bin/env -i PATH=${before}:/usr/bin:/bin /bin/sh -c "$2"\n`, {
			mode: 0o755,
		});
		process.env.SHELL = shell;
		// Not the developer's own Homebrew: a brew-installed gh would answer before setup does.
		process.env.OMP_GUI_TEST_BREW_DIRS = "";
		process.env.PATH = `${before}:/usr/bin:/bin`;
		resetLoginShellEnvCache();
		expect(await resolveBin("gh")).toBeNull();

		// What setup does after an install: the gh lands in the managed tools dir, and refreshPath
		// appends that dir to this process's PATH and drops the login-shell probe.
		await fs.writeFile(path.join(managed, "gh"), "#!/bin/sh\necho gh\n", { mode: 0o755 });
		process.env.PATH = `${process.env.PATH}:${managed}`;
		resetLoginShellEnvCache();
		expect(await resolveBin("gh")).toBe(path.join(managed, "gh"));
	});
});

describe("the git GUI git calls run", () => {
	it("names the developer dir's git, and nothing for a dir without one", async () => {
		const dir = await fakeDeveloperDir();
		expect(developerGit(`${dir}\n`)).toBe(path.join(dir, "usr", "bin", "git"));
		expect(developerGit(path.join(dir, "usr"))).toBeNull();
		expect(developerGit("")).toBeNull();
		expect(developerGit(null)).toBeNull();
	});

	it.skipIf(process.platform !== "darwin" || findOnPath("git", process.env.PATH ?? "") !== "/usr/bin/git")(
		"skips macOS's /usr/bin/git trampoline and runs the git it forwards to",
		async () => {
			process.env.DEVELOPER_DIR = await fakeDeveloperDir();
			const result = await gitRaw(os.tmpdir(), ["version"]);
			expect(result.stdout.toString("utf8").trim()).toBe("developer-git");
		},
	);
});
