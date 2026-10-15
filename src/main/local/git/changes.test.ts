import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGitChanges, getGitFingerprint } from "./changes";
import { gitRaw } from "./exec";
import { gitSync, initRepo } from "./test-repos";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-change-counts-"));
	await initRepo(root);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("checkout numstat", () => {
	it("counts net HEAD changes, including staged and unstaged lines, without inventing untracked or binary counts", async () => {
		await fs.writeFile(path.join(root, "README.md"), "hello\nstaged\n");
		await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1]));
		gitSync(root, "add", ".");
		await fs.writeFile(path.join(root, "README.md"), "hello\nstaged\nunstaged\n");
		await fs.writeFile(path.join(root, "new.txt"), "new\n");
		const { files } = await getGitChanges(root);
		expect(files.find(file => file.path === "README.md")).toMatchObject({ added: 2, removed: 0 });
		expect(files.find(file => file.path === "new.txt")).not.toHaveProperty("added");
		expect(files.find(file => file.path === "binary.dat")).not.toHaveProperty("added");
	});
	it("preserves renamed paths and their modification counts", async () => {
		await fs.writeFile(path.join(root, "old name.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
		gitSync(root, "add", ".");
		gitSync(root, "commit", "-qm", "rename base");
		gitSync(root, "mv", "old name.txt", "new name.txt");
		await fs.appendFile(path.join(root, "new name.txt"), "seven\n");
		const { files } = await getGitChanges(root);
		expect(files).toEqual([
			expect.objectContaining({ path: "new name.txt", oldPath: "old name.txt", added: 1, removed: 0 }),
		]);
	});
});

/** Top-level `git` processes `run` starts (git's own trace2 log; a child git of a git is not counted). */
async function gitProcesses(run: () => Promise<unknown>): Promise<number> {
	const log = path.join(root, "..", `trace-${path.basename(root)}-${Math.random().toString(36).slice(2)}.json`);
	process.env.GIT_TRACE2_EVENT = log;
	try {
		await run();
	} finally {
		delete process.env.GIT_TRACE2_EVENT;
	}
	const text = await fs.readFile(log, "utf8").catch(() => "");
	await fs.rm(log, { force: true });
	return text.split("\n").filter(line => line.includes('"event":"version"') && !/"sid":"[^"]*\//.test(line)).length;
}

describe("git call environment", () => {
	it("never lets a git call take optional locks (a status refresh may not collide with the agent's own git)", async () => {
		const echoed = await gitRaw(root, ["-c", "alias.show-lock=!echo $GIT_OPTIONAL_LOCKS", "show-lock"]);
		expect(echoed.stdout.toString("utf8").trim()).toBe("0");
	});
});

describe("checkout fingerprint", () => {
	it("stays the same while nothing changes and moves with every change get_git_changes would show", async () => {
		const seen = new Set<string>();
		const next = async () => {
			const { fingerprint } = await getGitFingerprint(root);
			expect(seen.has(fingerprint)).toBe(false);
			seen.add(fingerprint);
			return fingerprint;
		};
		const clean = await next();
		expect((await getGitFingerprint(root)).fingerprint).toBe(clean);
		await fs.writeFile(path.join(root, "README.md"), "hello\none\n");
		await next();
		// Same status letters (" M"), different content: the line counts changed, so the fingerprint must too.
		await fs.writeFile(path.join(root, "README.md"), "hello\none\ntwo\nthree\n");
		await next();
		await fs.mkdir(path.join(root, "dir"));
		await fs.writeFile(path.join(root, "dir", "a.txt"), "a\n");
		await next();
		// A second untracked file inside the same untracked directory.
		await fs.writeFile(path.join(root, "dir", "b.txt"), "b\n");
		await next();
		gitSync(root, "add", ".");
		await next();
		gitSync(root, "commit", "-qm", "second");
		await next();
	});

	it("answers for a folder outside a repository", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-repo-"));
		try {
			const first = await getGitFingerprint(outside);
			expect((await getGitFingerprint(outside)).fingerprint).toBe(first.fingerprint);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("costs two git processes per poll where a full read costs nine", async () => {
		await fs.writeFile(path.join(root, "README.md"), "hello\nmore\n");
		const full = await gitProcesses(() => getGitChanges(root));
		const poll = await gitProcesses(() => getGitFingerprint(root));
		console.info(`git processes per Changes tick: full read ${full}, fingerprint poll ${poll}`);
		expect(full).toBeGreaterThanOrEqual(9);
		expect(poll).toBe(2);
	});
});
