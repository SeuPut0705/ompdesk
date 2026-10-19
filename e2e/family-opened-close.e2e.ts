import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp, readRecords } from "./harness";

// Opened sessions fold and close like finished subagents (family-fold, auto-close): three children on the fake omp,
// real git. Derived from agent-review.e2e.ts; fan-out into git worktrees, then compare and merge (src/main/agent-control, work board review queue): the fake
// omp's agent calls the control tools (`fixture:host-tool:<name> <json>`) against a real git repository, so the
// worktrees, the merge and the removal are real git. The children's edits are committed by the test, standing in
// for what a real child does.

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

let app: ElectronApplication;
let page: Page;
let root: string;
let project: string;
let record: string;
let main: string;
let errors: string[];

test.beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-review-")));
	project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	git(project, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(project, "README.md"), "hello\n");
	git(project, "add", ".");
	git(project, "commit", "-q", "-m", "init");
	record = path.join(root, "rpc.jsonl");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, batchNotifications: false }),
	);
	app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: {
			OMP_GUI_HEADLESS: "1",
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_AGENT_SWEEP_MS: "500",
			OMP_GUI_TEST_SESSION_FILES: "1",
		},
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	main = (await tabs()).find(tab => tab.active)?.tabId ?? "";
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

const tabs = () => page.evaluate(() => window.omp.tabs.list());

async function results(): Promise<{ text: string; isError: boolean }[]> {
	return (await readRecords(record))
		.filter(frame => frame.type === "host_tool_result")
		.map(frame => {
			const result = frame.result as { content?: { text?: string }[] } | undefined;
			return { text: result?.content?.[0]?.text ?? "", isError: frame.isError === true };
		});
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
	const before = (await results()).length;
	const command = `fixture:host-tool:${name} ${JSON.stringify(args)}`;
	const response = await page.evaluate(
		([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }),
		[main, command] as const,
	);
	expect(response).toMatchObject({ success: true });
	await expect.poll(async () => (await results()).length, { timeout: 90_000 }).toBe(before + 1);
	return (await results())[before] as { text: string; isError: boolean };
}

/** The worktree sessions the agent opened, with their checkouts. */
async function children(): Promise<{ tabId: string; path: string; branch: string }[]> {
	return (await tabs())
		.filter(tab => tab.tabId !== main && tab.worktree)
		.map(tab => ({ tabId: tab.tabId, path: tab.worktree?.path ?? "", branch: tab.worktree?.branch ?? "" }));
}

test("finished opened sessions fold into one done row and their tabs close; unmerged work stays a visible row", async () => {
	test.setTimeout(240_000);
	const opened = await call("ompdesk_session_open", {
		sessions: [
			{ message: "Title: plain task\nread only fixture:result-ok" },
			{ message: "attempt b fixture:result-ok", worktree: true },
			{ message: "attempt c fixture:result-ok", worktree: true },
		],
	});
	expect(opened.isError).toBe(false);
	const all = (await tabs()).filter(tab => tab.tabId !== main);
	expect(all).toHaveLength(3);
	const plain = all.find(tab => !tab.worktree) as (typeof all)[number];
	const [b, c] = (await children()) as [
		{ tabId: string; path: string; branch: string },
		{ tabId: string; path: string; branch: string },
	];
	// The opener reads every answer, so nothing waits on it.
	await call("ompdesk_session_result", { sessions: all.map(tab => tab.tabId), wait: true, timeout_seconds: 90 });

	// The plain session has no branch: its final answer is in, so its tab closes. The session files stay.
	await expect
		.poll(async () => (await tabs()).some(tab => tab.tabId === plain.tabId), { timeout: 60_000 })
		.toBe(false);
	// B commits and lands in the parent (outside the app: only the sweep sees it); C commits and does not.
	for (const [child, file] of [
		[b, "part-b.txt"],
		[c, "part-c.txt"],
	] as const) {
		await fs.writeFile(path.join(child.path, file), `work of ${file}\n`);
		git(child.path, "add", file);
		git(child.path, "commit", "-q", "-m", `add ${file}`);
	}
	expect((await tabs()).some(tab => tab.tabId === b.tabId)).toBe(true);
	git(project, "merge", "-q", "--no-edit", b.branch);
	await expect.poll(async () => (await tabs()).some(tab => tab.tabId === b.tabId), { timeout: 60_000 }).toBe(false);
	// Merged and clean: its worktree and branch are gone. C keeps both.
	await expect
		.poll(
			async () =>
				fs.stat(b.path).then(
					() => true,
					() => false,
				),
			{ timeout: 30_000 },
		)
		.toBe(false);
	expect(git(project, "branch", "--list", b.branch)).toBe("");
	expect((await tabs()).some(tab => tab.tabId === c.tabId)).toBe(true);
	await fs.stat(c.path);
	expect(git(project, "branch", "--list", c.branch)).toContain(c.branch);

	// The family: two done behind one row (the closed sessions), the unmerged one a visible row with the failed mark.
	await page.locator("[data-sidebar-subagents-toggle]").first().click();
	await expect(page.locator("[data-family-done]")).toContainText("2 done", { timeout: 30_000 });
	const row = page.locator('[data-sidebar-opened-session][data-child-status="problem"]');
	await expect(row).toHaveCount(1);
	await expect(row.locator('[data-family-status="failed"]')).toHaveCount(1);
	await page.locator("[data-family-done]").click();
	await expect(page.locator("[data-sidebar-opened-session]")).toHaveCount(3);
	await expect.poll(async () => page.locator("body").innerText()).not.toContain("(untitled)");
	expect(git(project, "status", "--porcelain")).toBe("");
});
