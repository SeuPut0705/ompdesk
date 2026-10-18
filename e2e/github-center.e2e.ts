import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp, openDestination, variants } from "./harness";
import { resize } from "./shell-capture";

// Agents › GitHub (C94–C99) on the fake omp with a stand-in `gh` that records
// every call: issues (comment, close, another repository), Actions (re-run
// failed jobs, the failed log), a draft release, a notification marked read and
// a new repository with an explicit visibility.
// OMP_GUI_GITHUB_CAPTURES=<dir> keeps the captures.

const captures = process.env.OMP_GUI_GITHUB_CAPTURES;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

interface Seeded {
	root: string;
	project: string;
	bin: string;
}

async function seed(name: string): Promise<Seeded> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-github-${name}-`)));
	const project = path.join(root, "project");
	const bin = path.join(root, "ghbin");
	await Promise.all([fs.mkdir(project), fs.mkdir(bin)]);
	git(project, "init", "-q", "-b", "main");
	const json = (file: string, value: unknown) => fs.writeFile(path.join(bin, file), JSON.stringify(value));
	const issue = (number: number, title: string) => ({
		number,
		title,
		state: "OPEN",
		author: { login: "dev" },
		labels: [{ name: "bug" }],
		comments: [],
		updatedAt: "2026-10-14T10:00:00Z",
		url: `https://github.com/o/r/issues/${number}`,
	});
	const run = {
		databaseId: 99,
		workflowName: "CI",
		displayTitle: "CI on main",
		status: "completed",
		conclusion: "failure",
		headBranch: "main",
		event: "push",
		createdAt: "2026-10-14T10:00:00Z",
		url: "https://github.com/o/r/actions/runs/99",
	};
	await Promise.all([
		json("issues.json", [issue(12, "Login button misaligned")]),
		json("other-issues.json", [{ ...issue(3, "Other issue"), url: "https://github.com/other/lib/issues/3" }]),
		json("issue.json", { ...issue(12, "Login button misaligned"), body: "The button is 2px off." }),
		json("workflows.json", [{ id: 7, name: "CI", path: ".github/workflows/ci.yml", state: "active" }]),
		json("runs.json", [run]),
		json("run.json", { ...run, jobs: [{ name: "test", status: "completed", conclusion: "failure" }] }),
		json("notifications.json", [
			{
				id: "555",
				unread: true,
				reason: "review_requested",
				updated_at: "2026-10-14T10:00:00Z",
				subject: {
					title: "Review requested",
					url: "https://api.github.com/repos/o/r/pulls/7",
					type: "PullRequest",
				},
				repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
			},
		]),
		json("repos.json", [
			{
				nameWithOwner: "o/r",
				description: "The project",
				visibility: "PRIVATE",
				isFork: false,
				stargazerCount: 4,
				updatedAt: "2026-10-14T10:00:00Z",
				url: "https://github.com/o/r",
			},
		]),
	]);
	await fs.writeFile(
		path.join(bin, "gh"),
		[
			"#!/bin/sh",
			`echo "$*" >> "${bin}/calls.log"`,
			'case "$*" in',
			`"auth status"*) echo "github.com" >&2; echo "  ✓ Logged in to github.com account dev (keyring)" >&2 ;;`,
			`"repo view --json"*) echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;`,
			`"issue list"*"--repo other/lib"*) cat "${bin}/other-issues.json" ;;`,
			`"issue list"*) cat "${bin}/issues.json" ;;`,
			`"issue view"*) cat "${bin}/issue.json" ;;`,
			`"issue comment"*|"issue close"*|"run rerun"*|"api -X PATCH"*) ;;`,
			`"workflow list"*) cat "${bin}/workflows.json" ;;`,
			`"run list"*) cat "${bin}/runs.json" ;;`,
			`"run view"*"--log-failed"*) printf 'test\\tRun tests\\tboom: expected 1 to be 2\\n' ;;`,
			`"run view"*) cat "${bin}/run.json" ;;`,
			`"release list"*) echo '[]' ;;`,
			`"release create"*) echo "https://github.com/o/r/releases/tag/v1.2.0" ;;`,
			`"api notifications"*) cat "${bin}/notifications.json" ;;`,
			`"repo list"*) cat "${bin}/repos.json" ;;`,
			`"repo create"*) echo "https://github.com/dev/fresh" ;;`,
			"*) exit 1 ;;",
			"esac",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return { root, project: await fs.realpath(project), bin };
}

async function launch(
	seeded: Seeded,
	language: "en" | "ko",
	theme: "light" | "dark",
): Promise<{ app: ElectronApplication; page: Page }> {
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
		OMP_GUI_OMP: await fixtureOmp(seeded.root),
		OMP_GUI_REMOTE_PORT: "0",
		PATH: `${seeded.bin}${path.delimiter}${process.env.PATH}`,
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
	await resize(app, 1440, 900);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page };
}

for (const [language, theme] of variants([
	["en", "light"],
	["ko", "dark"],
] as const)) {
	test(`Agents › GitHub: issues, Actions, releases, notifications, repositories (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const seeded = await seed(`${language}-${theme}`);
		const { app, page } = await launch(seeded, language, theme);
		const calls = () => fs.readFile(path.join(seeded.bin, "calls.log"), "utf8").catch(() => "");
		const shoot = async (name: string) => {
			if (!captures) return;
			await fs.mkdir(captures, { recursive: true });
			await page.screenshot({
				animations: "disabled",
				path: path.join(captures, `${name}-${language}-${theme}.png`),
			});
		};
		const ko = language === "ko";
		try {
			await openDestination(page, "agents");
			const agents = page.locator('section[data-destination="agents"]');
			await agents.getByRole("tab", { name: "GitHub", exact: true }).click();
			const center = agents.locator("[data-github-center]");
			await expect(center.locator("[data-github-repo-shown]")).toHaveText("o/r");
			await center.getByRole("button", { name: /Login button misaligned/ }).click();
			const issue = center.locator('[data-github-issue="12"]');
			await expect(issue).toContainText("The button is 2px off.");
			await shoot("github-issues");
			if (ko) return;

			// C94: comment on and close the issue.
			await issue.getByLabel("Add a comment").fill("On it");
			await issue.getByRole("button", { name: "Comment", exact: true }).click();
			await expect.poll(calls).toContain("issue comment 12 --repo o/r --body-file");
			await issue.getByRole("button", { name: "Close issue", exact: true }).click();
			await expect.poll(calls).toContain("issue close 12 --repo o/r");

			// C99: another repository by owner/name, then back to the project's.
			await center.getByLabel("Repository (owner/name)").fill("other/lib");
			await center.getByRole("button", { name: "Use", exact: true }).click();
			await expect(center.locator("[data-github-repo-shown]")).toHaveText("other/lib");
			await expect(center.getByRole("button", { name: /Other issue/ })).toBeVisible();
			await center.getByRole("button", { name: "Use this project's", exact: true }).click();
			await expect(center.getByRole("button", { name: /Login button misaligned/ })).toBeVisible();

			// C96: re-run the failed jobs after a confirm, then read the failed steps' log.
			await center.getByRole("tab", { name: "Actions", exact: true }).click();
			await center.getByRole("button", { name: /CI on main/ }).click();
			const run = center.locator('[data-github-run="99"]');
			await expect(run).toContainText("test");
			await run.getByRole("button", { name: "Re-run failed jobs", exact: true }).click();
			const confirm = page.locator("[role=dialog], [role=alertdialog]").filter({ hasText: "Re-run this workflow?" });
			await confirm.getByRole("button", { name: "Re-run failed jobs", exact: true }).click();
			await expect.poll(calls).toContain("run rerun 99 --repo o/r --failed");
			await run.getByRole("button", { name: "View failed steps' log", exact: true }).click();
			await expect(run.locator("[data-github-log]")).toContainText("boom: expected 1 to be 2");
			await shoot("github-actions");

			// C97: a new release is a draft unless the user turns that off.
			await center.getByRole("tab", { name: "Releases", exact: true }).click();
			await center.getByRole("button", { name: "New release", exact: true }).click();
			const release = page.getByRole("dialog", { name: "New release" });
			await release.getByLabel("Tag").fill("v1.2.0");
			await release.getByLabel("Title", { exact: true }).fill("One two");
			await release.getByRole("button", { name: "Create release", exact: true }).click();
			await expect
				.poll(calls)
				.toMatch(/release create v1\.2\.0 --repo o\/r --title One two --notes-file \S+ --draft/);

			// C98: notifications, one marked read.
			await center.getByRole("tab", { name: "Notifications", exact: true }).click();
			const notification = center.locator('[data-github-notification="555"]');
			await expect(notification).toContainText("Review requested");
			await notification.getByRole("button", { name: "Mark as read", exact: true }).click();
			await expect.poll(calls).toContain("api -X PATCH notifications/threads/555");

			// C95: a new repository only after a visibility is chosen.
			await center.getByRole("tab", { name: "Repositories", exact: true }).click();
			await expect(center.getByRole("button", { name: /The project/ })).toBeVisible();
			await center.getByRole("button", { name: "New repository", exact: true }).click();
			const create = page.getByRole("dialog", { name: "New repository" });
			await create.getByLabel("Name", { exact: true }).fill("fresh");
			const submit = create.getByRole("button", { name: "Create repository", exact: true });
			await expect(submit).toBeDisabled();
			await create.getByLabel("Visibility").selectOption("private");
			await submit.click();
			await expect.poll(calls).toContain("repo create fresh --private");
		} finally {
			await exitApp(app);
			await fs.rm(seeded.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
