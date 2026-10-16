import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { developerGit, findOnPath, gitRaw } from "./exec";

const made: string[] = [];
afterEach(async () => {
	delete process.env.DEVELOPER_DIR;
	await Promise.all(made.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** A developer dir whose `usr/bin/git` prints a marker instead of running git. */
async function fakeDeveloperDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-developer-dir-"));
	made.push(dir);
	await fs.mkdir(path.join(dir, "usr", "bin"), { recursive: true });
	await fs.writeFile(path.join(dir, "usr", "bin", "git"), "#!/bin/sh\necho developer-git\n", { mode: 0o755 });
	return dir;
}

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
