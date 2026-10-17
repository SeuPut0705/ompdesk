import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp, pressShortcutUntilVisible, variants } from "./harness";

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

async function launch(policy: string, language: "en" | "ko" = "en"): Promise<void> {
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
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_WORKTREE_DIR: worktreeRoot,
			OMP_GUI_TEST_WORKTREE_LIFECYCLE: policy,
		},
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
	// Sent once (⌘T opens a tab each time it lands); the new tab may be slow to appear on a hosted runner.
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length, { timeout: 30_000 }).toBe(before.length + 1);
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

	test("GUI worktree removal recognises legacy directory names and keeps branches", async () => {
		const created = await page.evaluate(() => window.omp.rpc.worktreeCreate("gui-feature"));
		expect(created).toMatchObject({ success: true, data: { branch: "omp/gui/gui-feature" } });
		const data = created.data;
		if (
			!created.success ||
			!data ||
			typeof data !== "object" ||
			!("path" in data) ||
			typeof data.path !== "string" ||
			!("branch" in data) ||
			typeof data.branch !== "string"
		) {
			throw new Error("GUI worktree was not created");
		}
		expect(path.dirname(data.path)).toBe(worktreeRoot);
		const removed = await page.evaluate(target => window.omp.rpc.worktreeRemove(target), data.path);
		expect(removed.success).toBe(true);
		expect(await exists(data.path)).toBe(false);
		expect(git(project, "branch", "--list", data.branch)).toContain(data.branch);
		const legacy = path.join(worktreeRoot, "gui-old-sha-7654321");
		git(project, "worktree", "add", "-q", "-b", "omp/gui/legacy", legacy);
		const legacyRemoved = await page.evaluate(target => window.omp.rpc.worktreeRemove(target), legacy);
		expect(legacyRemoved.success).toBe(true);
		expect(await exists(legacy)).toBe(false);
		expect(await exists(path.join(project, "README.md"))).toBe(true);
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

// C82: Settings › Projects & launch › Worktree branch prefix names both the worktree tab's branch
// (⌥T dialog → worktree_create) and the session worktree's (stock wt/ gives way, the timestamp stays).
for (const { language, theme, label } of variants([
	{
		language: "en" as const,
		theme: "light" as const,
		label: { field: "Worktree branch prefix", name: "Name", submit: "Create & open" },
	},
	{
		language: "ko" as const,
		theme: "dark" as const,
		label: { field: "워크트리 브랜치 접두사", name: "이름", submit: "만들고 열기" },
	},
])) {
	test(`worktree branch prefix names worktree tab and session branches (${language}, ${theme})`, async () => {
		await launch("create:keep", language);
		await page.emulateMedia({ colorScheme: theme });
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="workspace"]').click();
		const row = settings.locator("#setting-gui-worktreeBranchPrefix");
		const field = row.getByRole("textbox", { name: label.field, exact: true });
		await field.fill("../x");
		await expect(field).toHaveAttribute("aria-invalid", "true");
		await field.fill("alice/");
		await field.press("Enter");
		await expect(row).toContainText("alice/fix-login");
		await expect.poll(() => page.evaluate(() => window.omp.prefs.get("worktreeBranchPrefix"))).toBe("alice/");
		const captures = process.env.OMP_GUI_WORKTREE_CAPTURES;
		if (captures) {
			await row.scrollIntoViewIfNeeded();
			await page.screenshot({ path: path.join(captures, `worktree-prefix-${language}-${theme}.png`) });
		}
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);

		// The session worktree first: a tab opened from a worktree tab's own folder is not a primary checkout.
		const tab = await openTab();
		expect(tab.worktree?.branch).toMatch(/^alice\/\d{8}-\d{6}/);
		expect(git(project, "branch", "--list", tab.worktree?.branch ?? "")).toContain(tab.worktree?.branch);

		await page.keyboard.press("Alt+t");
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("textbox", { name: label.name, exact: true }).fill("login");
		await expect(dialog).toContainText("alice/login");
		await dialog.getByRole("button", { name: label.submit, exact: true }).click();
		await expect(dialog).toHaveCount(0, { timeout: 20_000 });
		expect(git(project, "branch", "--list", "alice/login")).toContain("alice/login");
	});
}
