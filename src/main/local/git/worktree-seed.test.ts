import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itWithFileSymlinks } from "../../test-symlinks";
import type { BridgeClient } from "../types";
import { gitSync, initRepo, pathExists } from "./test-repos";
import { createWorktree } from "./worktree";
import { includePattern, runWorktreeSetup, SEED_MAX_BYTES, SETUP_SCRIPT, seedWorktree } from "./worktree-seed";

let scratch: string;
let repo: string;
let wtRoot: string;
const savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
const bridge: Pick<BridgeClient, "request"> = {
	async request<T>() {
		return { root: wtRoot, hash: "abc1234" } as T;
	},
};

beforeEach(async () => {
	scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-seed-")));
	repo = path.join(scratch, "repo");
	wtRoot = path.join(scratch, "wt");
	process.env.OMP_WORKTREE_DIR = wtRoot;
	await initRepo(repo);
});

afterEach(async () => {
	if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
	await fs.rm(scratch, { recursive: true, force: true });
});

async function freshWorktree(name: string): Promise<string> {
	const target = path.join(scratch, name);
	gitSync(repo, "worktree", "add", "-q", "-b", name, target);
	return target;
}

describe("includePattern", () => {
	it("refuses absolute, parent, .git and negated entries", () => {
		expect(includePattern("/etc/passwd")).toEqual({ refused: "absolute" });
		expect(includePattern("../x")).toEqual({ refused: "outside" });
		expect(includePattern("a/.git/config")).toEqual({ refused: "git" });
		expect(includePattern("!.env")).toEqual({ refused: "negation" });
		expect(includePattern("# note")).toBeNull();
		expect(includePattern("config/")).toEqual({ pattern: "config" });
	});
});

describe("seedWorktree", () => {
	it("copies ignored files and globs, never a tracked one, and reports the rest", async () => {
		await fs.writeFile(path.join(repo, ".gitignore"), ".env\n.env.*\nsecrets/\n");
		await fs.writeFile(path.join(repo, "tracked.txt"), "from git\n");
		gitSync(repo, "add", ".");
		gitSync(repo, "commit", "-q", "-m", "more");
		await fs.writeFile(path.join(repo, ".env"), "A=1\n");
		await fs.writeFile(path.join(repo, ".env.local"), "B=2\n");
		await fs.mkdir(path.join(repo, "secrets"));
		await fs.writeFile(path.join(repo, "secrets", "key"), "k\n");
		await fs.writeFile(path.join(repo, "tracked.txt"), "local edit\n");
		await fs.writeFile(
			path.join(repo, ".worktreeinclude"),
			"# local files\n.env\n.env.*\nsecrets\ntracked.txt\n../x\n",
		);
		const target = await freshWorktree("seed");

		const report = await seedWorktree(repo, target);

		expect(await fs.readFile(path.join(target, ".env"), "utf8")).toBe("A=1\n");
		expect(await fs.readFile(path.join(target, ".env.local"), "utf8")).toBe("B=2\n");
		expect(await fs.readFile(path.join(target, "secrets", "key"), "utf8")).toBe("k\n");
		// The checkout git made, whatever line ending core.autocrlf gave it (Windows runners check out CRLF).
		expect((await fs.readFile(path.join(target, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("from git\n");
		expect(report?.copied).toBe(3);
		expect(report?.skipped).toEqual(
			expect.arrayContaining([
				{ path: "tracked.txt", reason: "not_ignored" },
				{ path: "../x", reason: "outside" },
			]),
		);
	});

	it("is null without a .worktreeinclude", async () => {
		expect(await seedWorktree(repo, await freshWorktree("none"))).toBeNull();
	});

	it("stops at the size budget with a skip note", async () => {
		await fs.writeFile(path.join(repo, ".gitignore"), "*.bin\n");
		gitSync(repo, "commit", "-qam", "ignore bins");
		await fs.writeFile(path.join(repo, "a.bin"), Buffer.alloc(SEED_MAX_BYTES - 10));
		await fs.writeFile(path.join(repo, "b.bin"), Buffer.alloc(100));
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "*.bin\n");
		const target = await freshWorktree("budget");

		const report = await seedWorktree(repo, target);

		expect(report?.copied).toBe(1);
		expect(report?.skipped).toEqual([{ path: "b.bin", reason: "budget" }]);
		expect(await pathExists(path.join(target, "b.bin"))).toBe(false);
	});

	itWithFileSymlinks("refuses symlinks that lead outside the main checkout", async () => {
		const secret = path.join(scratch, "outside-secret");
		await fs.writeFile(secret, "nope\n");
		await fs.mkdir(path.join(scratch, "outside-dir"));
		await fs.writeFile(path.join(scratch, "outside-dir", ".env"), "nope\n");
		await fs.writeFile(path.join(repo, ".gitignore"), ".env\nlink\nvia/\n");
		gitSync(repo, "commit", "-qam", "ignore");
		await fs.symlink(secret, path.join(repo, "link"));
		await fs.symlink(path.join(scratch, "outside-dir"), path.join(repo, "via"));
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "link\nvia/.env\n");
		const target = await freshWorktree("links");

		const report = await seedWorktree(repo, target);

		expect(report?.copied).toBe(0);
		expect(report?.skipped.map(item => item.reason)).toEqual(["symlink_outside", "symlink_outside"]);
		expect(await pathExists(path.join(target, "link"))).toBe(false);
		expect(await pathExists(path.join(target, "via", ".env"))).toBe(false);
	});
	it("recreates an ignored folder link inside the checkout as a link in the worktree", async () => {
		await fs.mkdir(path.join(repo, "store"));
		await fs.writeFile(path.join(repo, "store", "pkg.js"), "x\n");
		await fs.writeFile(path.join(repo, ".gitignore"), "store/\nmodules\n");
		gitSync(repo, "commit", "-qam", "ignore");
		// A junction on Windows (no privilege needed, as pnpm makes them); a folder symlink elsewhere.
		await fs.symlink(path.join(repo, "store"), path.join(repo, "modules"), "junction");
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "modules\n");
		const target = await freshWorktree("junction");

		const report = await seedWorktree(repo, target);

		expect(report?.skipped).toEqual([]);
		expect((await fs.lstat(path.join(target, "modules"))).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(path.join(target, "modules", "pkg.js"), "utf8")).toBe("x\n");
	});
	itWithFileSymlinks(
		"copies an ignored file link on Windows, where making a file symlink needs Developer Mode",
		async () => {
			await fs.writeFile(path.join(repo, "real.env"), "A=1\n");
			await fs.writeFile(path.join(repo, ".gitignore"), "*.env\n");
			gitSync(repo, "commit", "-qam", "ignore");
			await fs.symlink(path.join(repo, "real.env"), path.join(repo, "link.env"));
			await fs.writeFile(path.join(repo, ".worktreeinclude"), "link.env\n");
			const target = await freshWorktree("filelink");
			const platform = Object.getOwnPropertyDescriptor(process, "platform");
			Object.defineProperty(process, "platform", { value: "win32" });
			try {
				const report = await seedWorktree(repo, target);
				expect(report?.skipped).toEqual([]);
			} finally {
				if (platform) Object.defineProperty(process, "platform", platform);
			}
			expect((await fs.lstat(path.join(target, "link.env"))).isSymbolicLink()).toBe(false);
			expect(await fs.readFile(path.join(target, "link.env"), "utf8")).toBe("A=1\n");
		},
	);
	it("leaves a force-added tracked file inside an ignored folder out, even when the target branch lacks it", async () => {
		await fs.writeFile(path.join(repo, ".gitignore"), "cache/\n");
		await fs.mkdir(path.join(repo, "cache"));
		await fs.writeFile(path.join(repo, "cache", "pinned.txt"), "tracked\n");
		gitSync(repo, "add", "-f", ".gitignore", "cache/pinned.txt");
		gitSync(repo, "commit", "-q", "-m", "force-add");
		await fs.writeFile(path.join(repo, "cache", "local.bin"), "ignored\n");
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "cache\n");
		// The target branch starts before the force-add, so the tracked file is absent there.
		const target = path.join(scratch, "older");
		gitSync(repo, "worktree", "add", "-q", "-b", "older", target, "HEAD~1");

		const report = await seedWorktree(repo, target);

		expect(await fs.readFile(path.join(target, "cache", "local.bin"), "utf8")).toBe("ignored\n");
		expect(await pathExists(path.join(target, "cache", "pinned.txt"))).toBe(false);
		expect(report?.skipped).toContainEqual({ path: path.join("cache", "pinned.txt"), reason: "not_ignored" });
	});

	itWithFileSymlinks(
		"never writes through a target-branch folder symlink that leads outside the worktree",
		async () => {
			const elsewhere = path.join(scratch, "elsewhere");
			await fs.mkdir(elsewhere);
			await fs.writeFile(path.join(repo, ".gitignore"), "conf/.env\n");
			gitSync(repo, "add", ".gitignore");
			gitSync(repo, "commit", "-q", "-m", "ignore");
			const target = await freshWorktree("trap");
			await fs.symlink(elsewhere, path.join(target, "conf"));
			gitSync(target, "add", "conf");
			gitSync(target, "commit", "-q", "-m", "conf is a link");
			await fs.mkdir(path.join(repo, "conf"));
			await fs.writeFile(path.join(repo, "conf", ".env"), "SECRET=1\n");
			await fs.writeFile(path.join(repo, ".worktreeinclude"), "conf/.env\n");

			const report = await seedWorktree(repo, target);

			expect(await fs.readdir(elsewhere)).toEqual([]);
			expect(report?.copied).toBe(0);
			expect(report?.skipped).toContainEqual({ path: "conf/.env", reason: "destination_outside" });
		},
	);
});

describe.skipIf(process.platform === "win32")("worktree setup hook", () => {
	it("runs .ompdesk/worktree-setup in the new worktree through createWorktree", async () => {
		await fs.mkdir(path.join(repo, ".ompdesk"));
		await fs.writeFile(
			path.join(repo, SETUP_SCRIPT),
			'echo "setup in $PWD"\nprintf "%s" "$OMPDESK_ROOT_PATH" > from-root.txt\n',
		);
		await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env\n");
		await fs.writeFile(path.join(repo, ".env"), "A=1\n");
		gitSync(repo, "add", ".ompdesk", ".worktreeinclude");
		gitSync(repo, "commit", "-q", "-m", "hook");

		const made = await createWorktree(repo, { name: "hooked" }, bridge);

		expect(made.seed?.copied).toBe(1);
		expect(made.setup).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
		expect(made.setup?.outputTail).toContain(`setup in ${made.path}`);
		expect(await fs.readFile(path.join(made.path, "from-root.txt"), "utf8")).toBe(repo);
		expect(await fs.readFile(made.setup?.logPath ?? "", "utf8")).toContain("setup in");
	});

	it("reports a failing hook without failing the worktree", async () => {
		await fs.mkdir(path.join(repo, ".ompdesk"));
		await fs.writeFile(path.join(repo, SETUP_SCRIPT), "echo broken >&2\nexit 3\n");

		const made = await createWorktree(repo, { name: "broken" }, bridge);

		expect(await pathExists(made.path)).toBe(true);
		expect(made.setup).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
		expect(made.setup?.outputTail).toContain("broken");
	});

	it("kills a hook past its timeout and never takes its exit code as success", async () => {
		await fs.mkdir(path.join(repo, ".ompdesk"));
		await fs.writeFile(path.join(repo, SETUP_SCRIPT), "trap 'exit 0' TERM\nsleep 30\n");
		const target = await freshWorktree("slow");

		const report = await runWorktreeSetup(repo, target, 500);

		expect(report).toMatchObject({ ok: false, timedOut: true, exitCode: null });
	});

	it("runs nothing without the script", async () => {
		expect(await runWorktreeSetup(repo, await freshWorktree("plain"))).toBeNull();
	});
});
