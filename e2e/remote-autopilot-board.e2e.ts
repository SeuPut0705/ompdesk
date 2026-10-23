import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { controlToolCaller, exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

// An Autopilot run on B viewed from A (a paired device): A's work board shows what B's shows. Its follow-ups (what
// the run left for later, what later cycles closed) and the child sessions its cycle opened: those are B's tabs, which
// only B's control tools know, so A's board asked its own and listed none (the user's report, 23 Oct 2026). The fake
// omp's cycles leave and resolve follow-ups through the bridge's own rules (e2e/fixture/autopilot.ts).

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

let parent: string;
let host: RemoteInstance | undefined;
let client: RemoteInstance | undefined;

test.beforeEach(async () => {
	parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-ap-board-")));
});

test.afterEach(async () => {
	for (const instance of [client, host]) if (instance) await exitApp(instance.app);
	await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** The run's status as a window's tab reads it, and the follow-up rows its board draws. */
async function board(page: Page, tabId: string) {
	const status = (await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_autopilot" }), tabId)) as {
		data?: { followups?: string[]; followupCycles?: number[]; cycle?: number; state?: string };
	};
	const rows = await page
		.locator("[data-work-board-panel] [data-autopilot-followup], [data-work-strip-panel] [data-autopilot-followup]")
		.evaluateAll(nodes => nodes.map(node => (node.textContent ?? "").trim()));
	return { status: status.data, rows };
}

test("a paired device's view of a run's work board shows the run's follow-ups and child sessions as the computer running it does", async () => {
	test.setTimeout(300_000);
	const worktrees = path.join(parent, "wt");
	const gate = path.join(parent, "gate");
	const early = path.join(parent, "early");
	const hostProfile = await makeRemoteProfile(parent, "host", {
		language: "en",
		theme: "light",
		env: {
			OMP_GUI_TEST_AUTOPILOT: JSON.stringify({
				cycleMs: 400,
				childMs: 600_000,
				cycles: {
					"1": { followups: ["Fix the flaky login test", "Speed up the board"], holdUntil: early },
					"2": { followups: ["Document the API"], resolved: ["Fix the flaky login test"] },
					"3": { followups: ["Speed up the board", "Trim the logs"] },
					"4": { followups: ["Cache the icons"], resolved: ["Document the API", "Trim the logs"] },
					"5": { followups: ["Split the store", "Fix the flaky login test"] },
					"6": { resolved: ["Speed up the board", "Cache the icons"] },
					"7": { followups: ["Rename the board"] },
					"8": { holdUntil: gate, children: 1 },
				},
			}),
			OMP_WORKTREE_DIR: worktrees,
			GIT_AUTHOR_NAME: "Seed",
			GIT_AUTHOR_EMAIL: "seed@example.invalid",
			GIT_COMMITTER_NAME: "Seed",
			GIT_COMMITTER_EMAIL: "seed@example.invalid",
		},
	});
	const repo = hostProfile.project;
	git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "index.ts"), "export const answer = 41;\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "seed");
	const clientProfile = await makeRemoteProfile(parent, "client", {
		language: "en",
		theme: "light",
		port: hostProfile.port,
		prefs: { agentControlManage: true },
	});
	host = await launchRemote(hostProfile);
	client = await launchRemote(clientProfile);
	for (const instance of [host, client])
		await instance.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1700, 1000));
	await connectHost(host.page, client.page, "PC-B");
	const call = await controlToolCaller(client.page, clientProfile.record);
	const started = await call("ompdesk_autopilot", { action: "start", device: "PC-B", folder: repo, ship: "commit" });
	expect(started.isError, started.text).toBe(false);
	const viewId = /Started Autopilot in session (\w+)/.exec(started.text)?.[1] ?? "";
	expect(viewId).not.toBe("");
	const hostTab = async () =>
		(await host?.page.evaluate(() => window.omp.tabs.list()))?.find(tab => tab.cwd.startsWith(worktrees))?.tabId;
	await expect.poll(hostTab, { timeout: 60_000 }).toBeTruthy();
	const runTab = (await hostTab()) ?? "";

	// A shows the run while its first cycle still works, then the run goes on: follow-ups come and go.
	await host.page
		.locator(".omp-session-sidebar")
		.getByText(/^Cycle \d/)
		.first()
		.click();
	await client.page.locator("[data-work-board-panel]").getByText("project · PC-B").first().click();
	await expect(client.page.locator("[data-work-board-panel] [data-autopilot-state]")).toBeVisible({ timeout: 30_000 });
	await fs.writeFile(early, "");
	const cycle = async () => (await board(host?.page as Page, runTab)).status?.cycle;
	await expect.poll(cycle, { timeout: 90_000 }).toBe(8);
	const expected = ["Rename the board", "Split the store", "Fix the flaky login test"];
	await expect.poll(async () => (await board(host?.page as Page, runTab)).status?.followups).toEqual(expected);
	await expect.poll(async () => (await board(client?.page as Page, viewId)).status?.followups).toEqual(expected);
	// What each window draws, with the run's tab in front.
	await expect.poll(async () => (await board(host?.page as Page, runTab)).rows.length, { timeout: 20_000 }).toBe(3);
	await expect
		.poll(async () => (await board(client?.page as Page, viewId)).rows, { timeout: 20_000 })
		.toEqual((await board(host.page, runTab)).rows);
	// Cycle 8 opens a child session and works on with it: both boards list it.
	await expect
		.poll(
			async () =>
				((await board(host?.page as Page, runTab)).status as { children?: unknown[] } | undefined)?.children
					?.length,
			{ timeout: 30_000 },
		)
		.toBeGreaterThan(0);
	const opened = (page: Page) =>
		page
			.locator("[data-work-board-panel] [data-board-opened]")
			.evaluateAll(nodes => nodes.map(node => (node.textContent ?? "").replace(/\d+s$/, "").trim()));
	await expect.poll(() => opened(host?.page as Page), { timeout: 20_000 }).toHaveLength(1);
	// A's board lists the run's child too, naming the computer it runs on, and opens it there.
	await expect.poll(() => opened(client?.page as Page), { timeout: 20_000 }).toHaveLength(1);
	expect((await opened(client.page))[0]).toContain("Autopilot child 1 of cycle 8");
	await expect(client.page.locator("[data-work-board-panel] [data-board-opened] [data-board-device]")).toHaveText(
		"PC-B",
	);
	await host.page.screenshot({ path: test.info().outputPath("host-run.png") });
	await client.page.screenshot({ path: test.info().outputPath("client-run.png") });
	const before = (await client.page.evaluate(() => window.omp.tabs.list())).length;
	await client.page.locator("[data-work-board-panel] [data-board-opened]").first().click();
	await expect.poll(async () => (await client?.page.evaluate(() => window.omp.tabs.list()))?.length).toBe(before + 1);
	await fs.writeFile(gate, "");
});
