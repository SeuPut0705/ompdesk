import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp, readRecords, untilAnswered } from "./harness";

// Fan-out into git worktrees, then compare and merge (src/main/agent-control): the work board shows the children as
// plain rows and no review section; the opener's agent lands them with the tools. The fake
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
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: {
			OMP_GUI_HEADLESS: "1",
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_AGENT_SWEEP_MS: "500",
			OMP_GUI_TEST_SESSION_COST: "0.25",
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

test("fan out into worktrees, compare, merge two through the tool, close a third; the board shows no review", async () => {
	test.setTimeout(240_000);
	const opened = await call("ompdesk_session_open", {
		sessions: [
			{ message: "attempt a", worktree: true },
			{ message: "attempt b", worktree: true },
			{ message: "attempt c", worktree: true },
		],
	});
	expect(opened.isError).toBe(false);
	const made = await children();
	expect(made).toHaveLength(3);

	for (const child of made) expect(child.branch).toMatch(/^omp\/agent\//);
	await call("ompdesk_session_result", { sessions: made.map(child => child.tabId), wait: true, timeout_seconds: 90 });
	for (const child of made) await untilAnswered(page, child.tabId);

	// The fake children do not edit; commit a file in each checkout the way a real child's work would land.
	for (const [index, child] of made.entries()) {
		const file = `part-${"abc"[index]}.txt`;
		await fs.writeFile(path.join(child.path, file), `work of ${"abc"[index]}\nsecond line\n`);
		git(child.path, "add", file);
		git(child.path, "commit", "-q", "-m", `add ${file}`);
	}

	// Sessions an agent opened live in its opener's family, whatever their folder: no row of their own, and the
	// children's folders (`gui-agent-<id>-<hash>`) never show. A finished child is listed only while it has work to
	// look at (its commits not landed): before the commits above, a finished, untouched child is done and leaves the
	// list once its review item lands (a hosted runner showed one row of three).
	const chip = page.locator("[data-sidebar-subagents-toggle]");
	await expect(chip).toHaveCount(1, { timeout: 30_000 });
	if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
	const family = page.locator("[data-sidebar-family] [data-sidebar-opened-session]");
	await expect(family).toHaveCount(3, { timeout: 30_000 });
	for (const label of ["attempt a", "attempt b", "attempt c"])
		await expect(family.filter({ hasText: label })).toHaveCount(1);
	await expect.poll(async () => page.locator("body").innerText()).not.toMatch(/gui-2026|gui-agent/);

	const compared = await call("ompdesk_compare");
	expect(compared.isError).toBe(false);
	for (const child of made)
		expect(compared.text).toContain(`branch ${child.branch} → main: 1 commit(s) ahead, 1 file(s) changed (+2 −0)`);
	// Each child's final answer, whichever came last: the brief's reply, or its answer to main's request to report (a
	// child that ended its turn with no Result line is asked to; `untilAnswered`, harness.ts).
	expect(compared.text.match(/final answer: (Local fixture reply|Read the note report from \w+\.)/g)).toHaveLength(3);
	expect(compared.text).toContain("Compare runs no tests");

	// The board has no review section and no Approve/Discard/Review buttons: the agent reviews and lands its own
	// children with the tools. The children show only as "Opened sessions" status rows.
	await expect(page.locator("[data-work-board-panel] [data-board-opened]")).toHaveCount(3, { timeout: 30_000 });
	await expect(page.locator('[data-board-section="review"]')).toHaveCount(0);
	await expect(page.locator("[data-review-child]")).toHaveCount(0);
	await expect(page.getByText("Needs review")).toHaveCount(0);
	await expect(page.locator(".omp-work-board-actions")).toHaveCount(0);
	// Each child's row says what it costs, and its tooltip what it runs on (main's review push, AgentChildUsage). Its
	// journal was spent on a subscription (the child's own host split it): an estimate at API prices, marked "≈".
	await expect(page.locator("[data-board-opened-cost]")).toHaveCount(3);
	await expect(page.locator("[data-board-opened-cost]").first()).toHaveText("≈ $0.25");
	for (const title of await page
		.locator("[data-board-opened]")
		.evaluateAll(rows => rows.map(row => row.getAttribute("title"))))
		expect(title).toMatch(/\/local-fixture · Estimate at API prices \$0\.25/);

	// The agent lands the first through the tool: with full control (the default) it merges at once, without a card.
	const first = made[0] as { tabId: string; path: string; branch: string };
	const landed = await call("ompdesk_merge", { session: first.tabId });
	expect(landed.isError).toBe(false);
	expect(landed.text).toContain("Nothing was pushed");
	expect(await fs.readFile(path.join(project, "part-a.txt"), "utf8")).toContain("work of a");
	expect(git(project, "log", "-1", "--format=%s")).toContain(`Merge ${first.branch} into main`);
	await expect(page.locator('[data-board-section="review"]')).toHaveCount(0);

	// With full control and "Let agents manage other sessions" stored off the tool asks first; a refusal merges
	// nothing.
	const second = made[1] as { tabId: string; path: string; branch: string };
	await page.evaluate(async () => {
		await window.omp.prefs.set("agentControlFull", false);
		await window.omp.prefs.set("agentControlManage", false);
	});
	const asked = call("ompdesk_merge", { session: second.tabId });
	await page
		.getByRole("button", { name: /Needs your answer/ })
		.first()
		.click({ timeout: 30_000 });
	await expect(page.getByText("[OMPdesk]").first()).toBeVisible({ timeout: 30_000 });
	await page.getByRole("button", { name: /^Deny/ }).first().click();
	expect((await asked).text).toContain("declined");
	await expect(fs.readFile(path.join(project, "part-b.txt"), "utf8")).rejects.toThrow();

	// Full control on again (the default): the tool merges at once with no card.
	await page.evaluate(() => window.omp.prefs.set("agentControlFull", true));
	const mergedResult = await call("ompdesk_merge", { session: second.tabId });
	await expect(page.getByText("[OMPdesk]")).toHaveCount(0);
	expect(mergedResult.isError).toBe(false);
	expect(mergedResult.text).toContain("Nothing was pushed");
	expect(await fs.readFile(path.join(project, "part-b.txt"), "utf8")).toContain("work of b");

	// Discard the third through the tool: its session closes and its work never reaches the parent. (`ompdesk_session_stop`
	// does not remove the worktree; the app's auto-close does that only for landed, clean branches.)
	const third = made[2] as { tabId: string; path: string; branch: string };
	const closed = await call("ompdesk_session_stop", { session: third.tabId, close: true });
	expect(closed.isError).toBe(false);
	await expect
		.poll(async () => (await tabs()).some(tab => tab.tabId === third.tabId), { timeout: 30_000 })
		.toBe(false);
	await expect(fs.stat(path.join(project, "part-c.txt"))).rejects.toThrow();
	// Read as the user's own git reads it: the app merged under that config (core.autocrlf=true on Windows writes CRLF
	// checkouts and calls them clean), which GIT_ENV's isolated config would call modified.
	expect(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).trim()).toBe("");
	// Nothing was ever pushed: the repository has no remote.
	expect(git(project, "remote")).toBe("");
});
