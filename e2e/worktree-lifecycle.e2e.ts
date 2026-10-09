import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// omp 18.8.6's per-session worktrees (`worktree.onStart` / `worktree.onExit`)
// in GUI tabs, on the fake omp with the settings switched on
// (OMP_GUI_TEST_WORKTREE_LIFECYCLE) over a real temp git repository. Worktrees
// land under a temp OMP_WORKTREE_DIR, never ~/.omp/wt.

let app: ElectronApplication;
let page: Page;
let profile: string;
let project: string;
let worktreeRoot: string;
let errors: string[];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const exists = (file: string) =>
	fs.stat(file).then(
		() => true,
		() => false,
	);

async function launch(policy: string): Promise<void> {
	profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-wt-lifecycle-")));
	project = path.join(profile, "project");
	worktreeRoot = path.join(profile, "wt");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "test@example.com");
	git(project, "config", "user.name", "Test");
	git(project, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(project, "README.md"), "hello\n");
	git(project, "add", ".");
	git(project, "commit", "-q", "-m", "init");
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_WORKTREE_DIR: worktreeRoot,
		OMP_GUI_TEST_WORKTREE_LIFECYCLE: policy,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
}

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

function tabs() {
	return page.evaluate(() => window.omp.tabs.list());
}

/** ⌘T from the focused tab; resolves the new tab once it is ready. */
async function openTab() {
	const before = (await tabs()).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
	const created = (await tabs()).find(tab => !before.includes(tab.tabId));
	if (!created) throw new Error("No new tab");
	await expect
		.poll(async () => (await tabs()).find(tab => tab.tabId === created.tabId)?.status, { timeout: 20_000 })
		.toBe("ready");
	await expect.poll(async () => (await tabs()).find(tab => tab.active)?.tabId).toBe(created.tabId);
	const ready = (await tabs()).find(tab => tab.tabId === created.tabId);
	if (!ready) throw new Error("New tab vanished");
	return ready;
}

function worktreeList(): string {
	return git(project, "worktree", "list", "--porcelain");
}

test.describe("worktree.onStart = create, worktree.onExit = remove", () => {
	test.beforeEach(async () => {
		await launch("create:remove");
	});

	test("a new tab lands in a fresh worktree, and closing it removes a clean one", async () => {
		// Opened on the project from the command line: not a new session, so no worktree.
		const [first] = await tabs();
		expect(first?.cwd).toBe(project);
		expect(first?.worktree).toBeUndefined();

		const tab = await openTab();
		const worktree = tab.worktree;
		expect(worktree).toMatchObject({ baseCwd: project, lifecycle: true });
		expect(worktree?.branch).toMatch(/^wt\/\d{8}-\d{6}/);
		expect(tab.cwd).toBe(worktree?.path);
		expect(path.dirname(worktree?.path ?? "")).toBe(worktreeRoot);
		expect(worktreeList()).toContain(`worktree ${worktree?.path}`);
		expect(git(project, "branch", "--list", worktree?.branch ?? "")).toContain(worktree?.branch);
		// A tab opened from it starts from the source checkout and gets its own worktree.
		const second = await openTab();
		expect(second.worktree?.baseCwd, JSON.stringify(second)).toBe(project);
		expect(second.worktree?.path).not.toBe(worktree?.path);

		// ⌘W skips the worktree close prompt: the renderer holds the lifecycle binding too.
		await page.keyboard.press("ControlOrMeta+w");
		await expect.poll(async () => (await tabs()).length).toBe(2);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		// The first worktree tab is in the background now; close it from main's side.
		await page.evaluate(id => window.omp.tabs.close(id), tab.tabId);
		for (const removed of [worktree, second.worktree]) {
			await expect.poll(() => exists(removed?.path ?? ""), { timeout: 15_000 }).toBe(false);
			expect(worktreeList()).not.toContain(removed?.path ?? "");
			expect(git(project, "branch", "--list", removed?.branch ?? "")).toBe("");
		}
		await expect(page.getByRole("dialog")).toHaveCount(0);
		expect(await exists(path.join(project, "README.md"))).toBe(true);
	});

	test("closing a dirty worktree's tab asks; Keep leaves it, Remove deletes it", async () => {
		const kept = await openTab();
		const keptPath = kept.worktree?.path ?? "";
		await fs.writeFile(path.join(keptPath, "work.txt"), "unsaved");
		await page.keyboard.press("ControlOrMeta+w");

		const dialog = page.getByRole("dialog", { name: "Remove worktree?" });
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText("It has uncommitted changes.");
		await expect(dialog).toContainText(keptPath);
		await dialog.getByRole("button", { name: "Keep" }).click();
		await expect(dialog).toBeHidden();
		expect(await fs.readFile(path.join(keptPath, "work.txt"), "utf8")).toBe("unsaved");
		expect(worktreeList()).toContain(keptPath);

		const removed = await openTab();
		const removedPath = removed.worktree?.path ?? "";
		await fs.writeFile(path.join(removedPath, "work.txt"), "scratch");
		await page.keyboard.press("ControlOrMeta+w");
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Remove" }).click();
		await expect.poll(() => exists(removedPath), { timeout: 15_000 }).toBe(false);
		expect(worktreeList()).not.toContain(removedPath);
	});
});

test.describe("worktree.onStart = ask, worktree.onExit = keep", () => {
	test.beforeEach(async () => {
		await launch("ask:keep");
	});

	test("a new tab asks first; the worktree it creates is kept on close", async () => {
		const question = page.getByRole("dialog", { name: "Create a worktree for this session?" });

		await page.keyboard.press("ControlOrMeta+t");
		await expect(question).toBeVisible();
		await expect(question).toContainText(project);
		await question.getByRole("button", { name: "Use this checkout" }).click();
		await expect.poll(async () => (await tabs()).filter(tab => tab.status === "ready").length).toBe(2);
		const plain = (await tabs()).find(tab => tab.active);
		expect(plain?.cwd).toBe(project);
		expect(plain?.worktree).toBeUndefined();

		await page.keyboard.press("ControlOrMeta+t");
		await expect(question).toBeVisible();
		await question.getByRole("button", { name: "Create worktree" }).click();
		await expect.poll(async () => (await tabs()).filter(tab => tab.worktree?.lifecycle).length).toBe(1);
		const owned = (await tabs()).find(tab => tab.worktree?.lifecycle);
		await expect.poll(async () => (await tabs()).find(tab => tab.tabId === owned?.tabId)?.status).toBe("ready");
		const ownedPath = owned?.worktree?.path ?? "";
		expect(owned?.cwd).toBe(ownedPath);

		await page.evaluate(id => window.omp.tabs.setActive(id), owned?.tabId ?? "");
		await page.keyboard.press("ControlOrMeta+w");
		await expect.poll(async () => (await tabs()).length).toBe(2);
		await page.waitForTimeout(500);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		expect(await exists(ownedPath)).toBe(true);
		expect(worktreeList()).toContain(ownedPath);
	});
});
