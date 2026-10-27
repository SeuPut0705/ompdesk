import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp, recordsOfType } from "./harness";

// Two sessions in one checkout (src/main/checkout-peers.ts, bridge modes/checkout-peers.ts): main tells each about
// the other, one agent's `git add -A` is refused by the guard and it stages its own file by name, the other session's
// edit survives unstaged and uncommitted, and the first session tells the second through `ompdesk_report`. The fake
// omp plays each agent's turn through the bridge's own guard (`fixture checkout:` prompts, e2e/fixture/checkout-peers.ts).
// The guard's rules, the section text and the repository-wide stash case are unit-tested in
// src/main/bridge-checkout-peers.test.ts; grouping by worktree and repository in src/main/checkout-peers.test.ts.

let app: ElectronApplication;
let page: Page;
let profile: string;
let project: string;
let errors: string[];
let record: string;

const git = (...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: project, encoding: "utf8" });

test.beforeEach(async () => {
	profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-shared-checkout-")));
	record = path.join(profile, "rpc.jsonl");
	project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(path.join(project, "src"), { recursive: true }), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(project, "src/a.ts"), "export const a = 1;\n");
	await fs.writeFile(path.join(project, "src/b.ts"), "export const b = 1;\n");
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_CHECKOUT_PEERS_MS: "300", OMP_GUI_TEST_RECORD: record },
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

async function lastAnswer(tabId: string): Promise<string> {
	const response = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "get_last_assistant_text" }),
		tabId,
	);
	return (response.data as { text?: string | null } | undefined)?.text ?? "";
}

/** `tabId`'s agent plays `steps` (see e2e/fixture/checkout-peers.ts) and finishes; resolves with its final answer. */
async function play(tabId: string, steps: object[]): Promise<string> {
	await page.evaluate(([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }), [
		tabId,
		`fixture checkout:${JSON.stringify(steps)}`,
	] as const);
	await expect.poll(() => lastAnswer(tabId), { timeout: 30_000 }).toMatch(/^Checkout steps finished/);
	return lastAnswer(tabId);
}

test("one session's bulk stage is refused, it commits its own file, and the other's edit survives", async () => {
	test.setTimeout(120_000);
	const first = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const spawned = await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
	const second = spawned?.tabId ?? "";
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === second)?.status)
		.toBe("ready");

	// The second session edits b.ts from the shell (measured: how two sessions overwrote each other); the first edits
	// a.ts, then reaches for b.ts and for `git add -A`.
	await play(second, [{ wait: "peers" }, { bash: "echo 'export const b = 2;' > src/b.ts" }]);
	const answer = await play(first, [
		{ wait: "peers" },
		{ write: "src/a.ts", content: "export const a = 2;\n" },
		{ write: "src/b.ts", content: "export const b = 'mine';\n" },
		{ bash: "echo 'export const b = 3;' > src/b.ts" },
		{ bash: "git add -A" },
		{ bash: "git add -- src/a.ts && git -c user.email=t@t -c user.name=t commit -q -m 'a' -- src/a.ts" },
	]);
	expect(answer).toContain("Refused while other sessions work here: writing src/b.ts whole with the write tool");
	expect(answer).toContain("Refused while other sessions work here: writing src/b.ts whole from the shell");
	expect(answer).toContain("Refused while other sessions work here: `git add -A`");

	// Only a.ts went into the commit; b.ts is still the second session's own, unstaged change.
	expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("src/a.ts");
	expect(git("status", "--porcelain")).toBe(" M src/b.ts\n");
	expect(await fs.readFile(path.join(project, "src/b.ts"), "utf8")).toBe("export const b = 2;\n");

	// The first session can reach the second: a note arrives without a turn, a question wakes it while idle.
	const report = async (kind: string, text: string): Promise<string> => {
		const before = (await recordsOfType(record, "host_tool_result")).length;
		await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
			first,
			`fixture:host-tool:ompdesk_report ${JSON.stringify({ to: second, kind, text })}`,
		] as const);
		await expect.poll(async () => (await recordsOfType(record, "host_tool_result")).length).toBe(before + 1);
		const result = (await recordsOfType(record, "host_tool_result"))[before]?.result as
			| { content?: { text?: string }[] }
			| undefined;
		return result?.content?.[0]?.text ?? "";
	};
	expect(await report("note", "Committed src/a.ts; src/b.ts is yours.")).toBe("Delivered.");
	expect(await report("question", "Shall I run the formatter on src/ after you commit?")).toMatch(
		/Wait for the answer/,
	);
	await expect.poll(() => lastAnswer(second), { timeout: 30_000 }).toBe(`Read the question report from ${first}.`);
	await page.keyboard.press("ControlOrMeta+2");
	const pane = page.locator(`.omp-session-pane[data-tab-id="${second}"]`);
	await expect(pane.locator("[data-agent-mail='note']")).toHaveCount(1, { timeout: 15_000 });
	await expect(pane.locator("[data-agent-mail='question']")).toContainText("Shall I run the formatter");
});

test("an edit of a file the other session changed carries the overlap notice once, and the board shows the task and the shared count", async () => {
	test.setTimeout(120_000);
	const first = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const spawned = await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
	const second = spawned?.tabId ?? "";
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === second)?.status)
		.toBe("ready");

	await play(first, [
		{ wait: "peers" },
		{ task: "Rename the a constant" },
		{ edit: "src/a.ts", append: "// first\n" },
	]);
	await play(second, [{ wait: "peers" }, { task: "Tune b" }, { edit: "src/b.ts", append: "// second\n" }]);

	const answer = await play(second, [
		{ wait: "files" },
		{ edit: "src/a.ts", append: "// second again\n" },
		{ edit: "src/a.ts", append: "// and again\n" },
		{ edit: "src/b.ts", append: "// own file only\n" },
	]);
	const notices = answer.split("<shared-checkout-overlap>").length - 1;
	expect(notices).toBe(1);
	expect(answer).toContain(`[${first}]`);
	expect(answer).toContain("working on: Rename the a constant");
	expect(answer).toContain("src/a.ts");
	expect(answer).toContain(`"to": "${first}", "kind": "note"`);

	// The first session edits the file the second changed: the same notice, naming the second and its task.
	const reverse = await play(first, [{ wait: "files" }, { edit: "src/b.ts", append: "// first on b\n" }]);
	expect(reverse.split("<shared-checkout-overlap>").length - 1).toBe(1);
	expect(reverse).toContain("working on: Tune b");

	await page.keyboard.press("ControlOrMeta+2");
	// The board shows once the session has a todo list; it docks beside the transcript (`workBoardFits`) or sits in the status strip, opened.
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:todo" }), second);
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900));
	const docked = page.locator(".omp-work-board-slot [data-work-board-panel]");
	const strip = page.locator("[data-work-chip]");
	await expect(docked.or(strip).first()).toBeVisible({ timeout: 15_000 });
	if ((await docked.count()) === 0) await strip.click();
	const board = (await docked.count()) > 0 ? docked : page.locator("[data-work-strip-panel]");
	const peers = board.locator("[data-board-session='peers']");
	await expect(peers).toContainText("1 session in this checkout · 2 shared files", { timeout: 15_000 });
	await peers.click();
	await expect(board.locator("[data-board-session='peer']")).toContainText("Rename the a constant");
});
