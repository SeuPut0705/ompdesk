import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp, readRecords } from "./harness";

// Disk care over folders that hold an Electron app archive (every Electron project's
// node_modules/electron/dist/resources/default_app.asar). Electron's own `fs` opens any `*.asar` it stats, copies or
// removes and keeps the archive open for the life of the process, and Windows cannot delete a file another process
// holds open. So the landed sweep's size measurement made git fail to remove the worktree, its archive of ignored
// files could not remove its own copy, and the worktree root's and the Bun cache's measurement kept every other
// folder's archive undeletable until OMPdesk quit. A real app, a real archive, real git; on macOS nothing locks and it
// passes anyway. The Bun cache is a private one: the user's would be walked in full (3 GB here).

/** Where the planted archives sit, as in a Windows project's checkout. */
const ARCHIVE = path.join("node_modules", "electron", "dist", "resources", "default_app.asar");
/** This machine's copy of the same archive: macOS keeps it inside Electron.app (nightly 39510409009 failed ENOENT). */
const SOURCE =
	process.platform === "darwin"
		? path.join("node_modules", "electron", "dist", "Electron.app", "Contents", "Resources", "default_app.asar")
		: ARCHIVE;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const exists = (file: string) =>
	fs.stat(file).then(
		() => true,
		() => false,
	);

async function plantArchive(folder: string, relative: string): Promise<void> {
	const target = path.join(folder, relative);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.copyFile(path.resolve(SOURCE), target);
}

test("disk care removes landed worktrees holding an .asar and leaves other folders' archives deletable", async () => {
	test.setTimeout(120_000);
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-disk-asar-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const worktreeRoot = path.join(profile, "wt");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(worktreeRoot)]);
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "test@example.com");
	git(project, "config", "user.name", "Test");
	git(project, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(project, ".gitignore"), "node_modules/\nvendor/\n");
	await fs.writeFile(path.join(project, "package.json"), '{"name":"demo"}\n');
	await fs.writeFile(path.join(project, "package-lock.json"), '{"lockfileVersion":3}\n');
	git(project, "add", ".");
	git(project, "commit", "-q", "-m", "init");
	// Landed (its branch starts at main's tip with nothing of its own) and clean (the archives are ignored).
	// `node_modules` has a tracked lockfile, so it is regenerable: measured, never copied. `vendor` is no one's
	// output: its files are archived (copied) before the worktree goes.
	const installed = path.join(worktreeRoot, "gui-installed-abcdef1");
	const vendored = path.join(worktreeRoot, "gui-vendored-abcdef1");
	git(project, "worktree", "add", "-q", "-b", "omp/gui/installed", installed);
	git(project, "worktree", "add", "-q", "-b", "omp/gui/vendored", vendored);
	await plantArchive(installed, ARCHIVE);
	await plantArchive(vendored, path.join("vendor", "app.asar"));
	// Not worktrees: only the size measurement of the worktree root and of Bun's install cache walks them.
	const stray = path.join(worktreeRoot, "old-checkout");
	const bunCache = path.join(profile, "bun-cache");
	await plantArchive(stray, ARCHIVE);
	await plantArchive(bunCache, path.join("electron@36.9.5@@@1", "dist", "resources", "default_app.asar"));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));

	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_WORKTREE_DIR: worktreeRoot, OMP_GUI_TEST_DISK_CARE_WORKTREES: "1", BUN_INSTALL_CACHE_DIR: bunCache },
	});
	try {
		const page = await app.firstWindow();
		await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");

		const state = await page.evaluate(() => window.omp.diskCare.run());
		const log = (await readRecords(path.join(desktop, "logs", "gui-runtime.jsonl")))
			.filter(record => record.source === "disk-care")
			.map(record => `${record.message} ${JSON.stringify(record.details)}`)
			.join("\n");
		expect(state.lastRun?.failed, log).toBe(0);
		expect(await exists(installed), log).toBe(false);
		expect(await exists(vendored), log).toBe(false);
		expect(git(project, "worktree", "list", "--porcelain")).not.toMatch(/gui-(installed|vendored)-/);

		// The app is still running: its measurements must not hold the other folders' archives.
		await fs.rm(stray, { recursive: true });
		await fs.rm(bunCache, { recursive: true });
		expect(await exists(stray)).toBe(false);
		expect(await exists(bunCache)).toBe(false);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true });
	}
});
