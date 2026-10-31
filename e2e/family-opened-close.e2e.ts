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

test("finished opened sessions are not listed and their tabs close; unmerged work stays a visible row", async () => {
	test.setTimeout(240_000);
	const opened = await call("ompdesk_session_open", {
		sessions: [
			{ message: "Title: plain task\nread only fixture:result-ok" },
			{ message: "attempt b fixture:result-ok", worktree: true },
			{ message: "attempt c fixture:result-ok", worktree: true },
		],
	});
	expect(opened.isError).toBe(false);
	// The plain child can finish and close before the next read (the opener is idle, so nothing waits on it: a loaded
	// runner listed only the two worktree children here), so its id comes from the open's own answer.
	const ids = [...opened.text.matchAll(/Opened session (\w+)/g)].map(match => match[1] ?? "");
	expect(ids).toHaveLength(3);
	const [b, c] = (await children()) as [
		{ tabId: string; path: string; branch: string },
		{ tabId: string; path: string; branch: string },
	];
	const plain = { tabId: ids.find(id => id !== b.tabId && id !== c.tabId) ?? "" };
	expect(plain.tabId).not.toBe("");
	// The opener reads every answer, so nothing waits on it.
	await call("ompdesk_session_result", { sessions: ids, wait: true, timeout_seconds: 90 });

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

	// The family: the two closed sessions (done, landed) are not listed at all; the unmerged one is a visible row with
	// the ready-to-merge mark, never the failed one (29 Oct 2026: it finished cleanly).
	await page.locator("[data-sidebar-subagents-toggle]").first().click();
	const row = page.locator('[data-sidebar-opened-session][data-child-status="unmerged"]');
	await expect(row).toHaveCount(1, { timeout: 30_000 });
	await expect(row.locator('[data-family-status="unmerged"]')).toHaveCount(1);
	await expect(row.locator('[data-family-status="failed"]')).toHaveCount(0);
	await expect(page.locator("[data-sidebar-opened-session]")).toHaveCount(1);
	await expect.poll(async () => page.locator("body").innerText()).not.toContain("(untitled)");
	expect(git(project, "status", "--porcelain")).toBe("");
});

/** The children's saved session files (`OMP_GUI_TEST_SESSION_FILES`) whose text holds `marker`; never the opener's. */
async function savedWith(marker: string): Promise<string[]> {
	const dir = path.join(root, "agent", "sessions", "fixture");
	const opener = (await tabs()).find(tab => tab.tabId === main)?.sessionPath;
	const names = (await fs.readdir(dir).catch(() => [] as string[])).filter(
		name => !opener || path.basename(opener) !== name,
	);
	const hits = await Promise.all(
		names.map(async name => ((await fs.readFile(path.join(dir, name), "utf8")).includes(marker) ? name : null)),
	);
	return hits.filter((name): name is string => name !== null);
}

test("a throwaway session is closed and deleted once its answer is in; a kept one stays reachable by its id", async () => {
	test.setTimeout(180_000);
	const opened = await call("ompdesk_session_open", {
		sessions: [
			{ message: "Title: throwaway lookup\nread only fixture:result-ok", throwaway: true },
			{ message: "Title: kept lookup\nread only fixture:result-ok" },
		],
	});
	expect(opened.isError).toBe(false);
	expect(opened.text).toContain("throwaway");
	const [throwaway, kept] = [...opened.text.matchAll(/Opened session (\w+)/g)].map(match => match[1] ?? "");
	expect(throwaway).toBeTruthy();
	expect(kept).toBeTruthy();

	// Both close once their answers are in; only the throwaway one's saved session goes with its tab.
	await expect
		.poll(async () => (await tabs()).some(tab => tab.tabId === throwaway || tab.tabId === kept), { timeout: 60_000 })
		.toBe(false);
	await expect.poll(() => savedWith("throwaway lookup"), { timeout: 30_000 }).toEqual([]);
	expect(await savedWith("kept lookup")).toHaveLength(1);

	// The kept one's id still names its saved session after its tab closed: read it, then delete it by that id.
	const read = await call("ompdesk_session_read", { session: kept });
	expect(read.isError).toBe(false);
	const deleted = await call("ompdesk_session_stop", { session: kept, delete: true });
	expect(deleted).toMatchObject({ isError: false });
	expect(deleted.text).toContain("Deleted");
	await expect.poll(() => savedWith("kept lookup"), { timeout: 30_000 }).toEqual([]);
});
