import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp, openDestination } from "./harness";
import { capturer, type Finding, resize } from "./shell-capture";

// Source control in the Changes panel and PR merge in the PR Center, on the
// fake omp with a real git checkout, a bare remote and a stand-in `gh`:
// stage, commit, push, the commit history, the branch picker and a squash
// merge. English/light runs the whole flow; every language × theme pair also
// captures the panel wide and at the smallest window when
// OMP_GUI_SCM_CAPTURES=<dir> is set.

const directory = process.env.OMP_GUI_SCM_CAPTURES;
test.describe.configure({ mode: "parallel" });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

interface Seeded {
	root: string;
	project: string;
	remote: string;
	bin: string;
}

async function seed(name: string): Promise<Seeded> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-scm-${name}-`)));
	const project = path.join(root, "project");
	const remote = path.join(root, "remote.git");
	const bin = path.join(root, "ghbin");
	await Promise.all([fs.mkdir(project), fs.mkdir(bin)]);
	git(root, "init", "-q", "--bare", "remote.git");
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "scm@example.com");
	git(project, "config", "user.name", "Scm");
	git(project, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(project, "README.md"), "# Project\n");
	await fs.writeFile(path.join(project, "app.ts"), "export const answer = 41;\n");
	git(project, "add", ".");
	git(project, "commit", "-qm", "feat: seed the project");
	git(project, "remote", "add", "origin", remote);
	git(project, "push", "-q", "-u", "origin", "main");
	git(project, "branch", "feature/login");
	await fs.writeFile(path.join(project, "app.ts"), "export const answer = 42;\n");
	await fs.writeFile(path.join(project, "notes.md"), "Draft notes\n");
	const pr = {
		number: 7,
		title: "Add the login screen",
		url: "https://github.com/o/r/pull/7",
		author: { login: "dev" },
		headRefName: "feature/login",
		baseRefName: "main",
		state: "OPEN",
		mergeStateStatus: "CLEAN",
	};
	await fs.writeFile(path.join(bin, "list.json"), JSON.stringify([pr]));
	await fs.writeFile(path.join(bin, "view.json"), JSON.stringify({ ...pr, body: "Adds the login screen." }));
	await fs.writeFile(path.join(bin, "comments.json"), JSON.stringify({ comments: [], reviews: [] }));
	await fs.writeFile(
		path.join(bin, "gh"),
		[
			"#!/bin/sh",
			'case "$1 $2" in',
			`"repo view") echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;`,
			`"pr list") cat "${bin}/list.json" ;;`,
			`"pr view") case "$*" in *comments*) cat "${bin}/comments.json" ;; *) cat "${bin}/view.json" ;; esac ;;`,
			`"api repos/o/r/pulls/7/comments?per_page=100") echo '[]' ;;`,
			`"pr merge") echo "$*" > "${bin}/merged.args" ;;`,
			"*) exit 1 ;;",
			"esac",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return { root, project: await fs.realpath(project), remote, bin };
}

async function launch(
	seeded: Seeded,
	language: "en" | "ko",
	theme: "light" | "dark",
	standInGh = true,
): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
	const desktop = path.join(seeded.root, "desktop");
	const agent = path.join(seeded.root, "agent");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const env: Record<string, string | undefined> = {
		...process.env,
		OMP_GUI_HEADLESS: "1",
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), seeded.root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(seeded.root),
		OMP_GUI_REMOTE_PORT: "0",
		...(standInGh ? { PATH: `${seeded.bin}${path.delimiter}${process.env.PATH}` } : {}),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			seeded.project,
			`--user-data-dir=${desktop}`,
		],
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await resize(app, 1440, 900);
	await page.waitForFunction(() => window.omp?.rpc != null);
	try {
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
			.toBe("ready");
	} catch (error) {
		// A stuck start says nothing by itself: carry the sidecar's own status and the app's runtime log.
		const status = await page.evaluate(() => window.omp.sidecar.getStatus()).catch(() => null);
		const log = await fs.readFile(path.join(desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => "");
		throw new Error(`The sidecar never became ready: ${JSON.stringify(status)}\n${log.slice(-4000)}`, {
			cause: error,
		});
	}
	return { app, page, errors };
}

/** The side panel on Changes: docked when wide, a sheet in a narrow window. */
async function openChanges(page: Page, language: "en" | "ko") {
	const button = page
		.locator(".omp-panel-topbar:visible")
		.getByRole("button", { name: language === "ko" ? "변경 사항" : "Changes", exact: true })
		.first();
	// A resize swaps the docked panel for a sheet (or closes it); toggle until the view button shows.
	await expect(async () => {
		if (!(await button.isVisible())) await page.keyboard.press("ControlOrMeta+j");
		await expect(button).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await button.click();
	const panel = page
		.locator("aside[data-docked]:visible, [role=dialog]:visible")
		.filter({ has: page.locator(".omp-panel-topbar") })
		.first();
	await expect(panel.locator("[data-scm-bar]")).toBeVisible({ timeout: 20_000 });
	return panel;
}

test("stage, commit, push, history and a squash merge", async () => {
	test.setTimeout(180_000);
	const seeded = await seed("flow");
	const { app, page, errors } = await launch(seeded, "en", "light");
	const findings: Finding[] = [];
	const shoot = capturer(page, directory, "scm-flow", findings);
	try {
		const aside = await openChanges(page, "en");
		await expect(aside.getByText("0 of 2 staged")).toBeVisible();
		await aside.getByRole("checkbox", { name: "Stage app.ts" }).click();
		await expect(aside.getByText("1 of 2 staged")).toBeVisible();
		expect(git(seeded.project, "diff", "--cached", "--name-only")).toBe("app.ts");
		const commit = aside.getByRole("button", { name: "Commit 1 to main" });
		await expect(commit).toBeDisabled();
		await aside.getByRole("textbox", { name: "Commit message" }).fill("fix: the answer is 42");
		await shoot("ready-to-commit");
		await commit.click();
		await expect(aside.getByText("0 of 1 staged")).toBeVisible();
		expect(git(seeded.project, "log", "-1", "--format=%s")).toBe("fix: the answer is 42");
		const push = aside.locator("[data-scm-bar]").getByRole("button", { name: /^Push/ });
		await expect(push).toHaveText("Push1");
		await push.click();
		await expect(push).toHaveText("Push");
		expect(git(seeded.root, "--git-dir", seeded.remote, "log", "-1", "--format=%s", "main")).toBe(
			"fix: the answer is 42",
		);

		// The branch picker lists local and remote branches.
		await aside
			.locator("[data-scm-bar]")
			.getByRole("button", { name: /^On main/ })
			.click();
		const picker = page.getByRole("dialog", { name: "Branches" });
		await expect(picker.getByRole("button", { name: "feature/login", exact: true })).toBeVisible();
		await expect(picker.getByRole("button", { name: "origin/main", exact: true })).toBeVisible();
		await shoot("branch-picker");
		await page.keyboard.press("Escape");

		// Commits: the new commit first; its files and diff.
		await aside.getByRole("combobox", { name: "Changes" }).selectOption("commits");
		const history = aside.locator("[data-commit-history]");
		await history.getByRole("button", { name: /fix: the answer is 42/ }).click();
		await history.getByRole("button", { name: /app\.ts/ }).click();
		await expect(history).toContainText("export const answer = 42;");
		await shoot("commit-diff");

		// C77: two unpushed commits; the newest moves before the one under it.
		git(seeded.project, "commit", "-q", "--allow-empty", "-m", "chore: first local");
		git(seeded.project, "commit", "-q", "--allow-empty", "-m", "chore: second local");
		const newest = git(seeded.project, "rev-parse", "--short", "HEAD");
		await history.getByRole("button", { name: "Back to the commit", exact: true }).click();
		await history.getByRole("button", { name: "Back to commits", exact: true }).click();
		await history.getByRole("button", { name: "Refresh", exact: true }).click();
		await expect(history).toContainText("chore: second local");
		await history.getByRole("button", { name: `Actions for ${newest}`, exact: true }).click();
		await page.getByRole("menuitem", { name: "Move before the previous commit", exact: true }).click();
		await expect
			.poll(() => git(seeded.project, "log", "-3", "--format=%s"))
			.toBe("chore: first local\nchore: second local\nfix: the answer is 42");
		await aside.getByRole("combobox", { name: "Changes" }).selectOption("repository");

		// PR Center: squash merge through gh, deleting the head branch on GitHub.
		await openDestination(page, "agents");
		const agents = page.locator('section[data-destination="agents"]');
		await agents.getByRole("tab", { name: "Pull requests" }).click();
		await agents.getByRole("button", { name: /Add the login screen/ }).click();
		await agents.getByRole("button", { name: "Merge", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Merge pull request #7" });
		await dialog.getByRole("combobox", { name: "Merge method" }).selectOption("squash");
		await shoot("pr-merge-dialog");
		await dialog.getByRole("button", { name: "Squash and merge" }).click();
		await expect
			.poll(() => fs.readFile(path.join(seeded.bin, "merged.args"), "utf8").catch(() => ""))
			.toBe("pr merge 7 --repo o/r --squash --delete-branch\n");
		expect(errors).toEqual([]);
	} finally {
		if (directory)
			await fs.writeFile(path.join(directory, "scm-flow-findings.json"), JSON.stringify(findings, null, 2));
		await exitApp(app);
		await fs.rm(seeded.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

// What the Windows smoke run covers (the stand-in `gh` is a shell script): stage a file, commit it
// through the panel and push it to the bare remote, all with the real git.
test("@smoke stage, commit and push from the Changes panel", async () => {
	test.setTimeout(120_000);
	const seeded = await seed("smoke");
	const { app, page, errors } = await launch(seeded, "en", "light", false);
	try {
		const aside = await openChanges(page, "en");
		await expect(aside.getByText("0 of 2 staged")).toBeVisible();
		await aside.getByRole("checkbox", { name: "Stage app.ts" }).click();
		await expect(aside.getByText("1 of 2 staged")).toBeVisible();
		expect(git(seeded.project, "diff", "--cached", "--name-only")).toBe("app.ts");
		await aside.getByRole("textbox", { name: "Commit message" }).fill("fix: the answer is 42");
		await aside.getByRole("button", { name: "Commit 1 to main" }).click();
		await expect(aside.getByText("0 of 1 staged")).toBeVisible();
		expect(git(seeded.project, "log", "-1", "--format=%s")).toBe("fix: the answer is 42");
		const push = aside.locator("[data-scm-bar]").getByRole("button", { name: /^Push/ });
		await expect(push).toHaveText("Push1");
		await push.click();
		await expect(push).toHaveText("Push");
		expect(git(seeded.root, "--git-dir", seeded.remote, "log", "-1", "--format=%s", "main")).toBe(
			"fix: the answer is 42",
		);
		if (directory) await page.screenshot({ path: path.join(directory, "scm-smoke-pushed.png"), scale: "css" });
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(seeded.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

for (const [language, theme] of [
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const) {
	test(`source control captures ${language}-${theme}`, async () => {
		test.skip(!directory, "set OMP_GUI_SCM_CAPTURES=<dir> to capture the source-control views");
		test.setTimeout(120_000);
		const seeded = await seed(`${language}-${theme}`);
		git(seeded.project, "add", "app.ts");
		const { app, page, errors } = await launch(seeded, language, theme);
		const findings: Finding[] = [];
		const shoot = capturer(page, directory, `scm-${language}-${theme}`, findings);
		try {
			const aside = await openChanges(page, language);
			await expect(aside.locator('[data-staged="all"]')).toHaveCount(1);
			await shoot("changes-1440");
			await aside.locator("[data-scm-bar]").getByRole("button").first().click();
			await page.waitForTimeout(300);
			await shoot("branch-picker-1440");
			await page.keyboard.press("Escape");
			await resize(app, 800, 640);
			// The narrow window closes the docked panel; open Changes again.
			const narrow = await openChanges(page, language);
			await page.waitForTimeout(300);
			await shoot("changes-800");
			await narrow.locator("select").first().selectOption("commits");
			await expect(narrow.locator("[data-commit-history]")).toContainText("feat: seed the project");
			await shoot("commits-800");
			await resize(app, 1440, 900);
			await openDestination(page, "agents");
			const agents = page.locator('section[data-destination="agents"]');
			await agents.getByRole("tab", { name: /^(Pull requests|풀 리퀘스트)$/ }).click();
			await agents.getByRole("button", { name: /Add the login screen/ }).click();
			await expect(agents.getByRole("heading", { name: /Add the login screen/ })).toBeVisible();
			await page.waitForTimeout(300);
			await shoot("pr-detail-1440");
			expect(errors).toEqual([]);
		} finally {
			if (directory)
				await fs.writeFile(
					path.join(directory, `scm-${language}-${theme}-findings.json`),
					JSON.stringify(findings, null, 2),
				);
			await exitApp(app);
			await fs.rm(seeded.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
