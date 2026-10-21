import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { controlToolCaller as caller, exitApp, launchApp, openedSessions as opened, readRecords } from "./harness";
import {
	connectHost,
	type LinkProxy,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	type RemoteInstance,
} from "./remote-harness";

// OMPdesk control tools beyond the caller's window (src/main/agent-control): another window's sessions, saved
// sessions read and reopened without a tab, a judged compare of two sessions, and sessions on a paired device: one
// opened there whose prompt runs on that device's omp, whose saved transcript is read back (paged), reopened after its
// tab closed and deleted by its saved id; one that is shown, notifies and reports to its opener across the link; a
// schedule created, listed and cancelled there, kept in that device's own schedules.json; and a worktree session on
// that device compared and merged there with real git. The fake omp calls a tool with
// `fixture:host-tool:<name> <json>` and records the `host_tool_result` it gets; its judge (`agent_control.judge`)
// ranks the sessions in evidence order. The rules behind each answer are unit-tested in
// src/main/agent-control/service.test.ts, host.test.ts and src/main/remote/host-services.test.ts (host.git.*).

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

test.describe("on this computer", () => {
	let app: ElectronApplication;
	let page: Page;
	let profile: string;
	let record: string;
	let errors: string[];

	test.beforeEach(async () => {
		profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-across-"));
		const project = path.join(profile, "project");
		const desktop = path.join(profile, "desktop");
		const agent = path.join(profile, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		record = path.join(profile, "rpc.jsonl");
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({
				language: "en",
				firstRunComplete: true,
				agentControlManage: true,
			}),
		);
		app = await launchApp({
			project,
			desktop,
			agent,
			profile,
			env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_RECORD: record, OMP_GUI_TEST_SESSION_FILES: "1" },
		});
		page = await app.firstWindow();
		errors = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	});

	test.afterEach(async () => {
		if (app) await exitApp(app);
		if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
		if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		expect(errors).toEqual([]);
	});

	test("lists another window's sessions, judges two sessions, then reads and reopens a closed one", async () => {
		test.setTimeout(240_000);
		const call = await caller(page, record);

		// A second window with its own session: not in the caller's window, listed with scope app.
		expect(await page.evaluate(() => window.omp.sessions.openInNewWindow({}))).toBe(true);
		await expect.poll(() => app.windows().length, { timeout: 30_000 }).toBe(2);
		await expect
			.poll(async () => (await call("ompdesk_sessions", { scope: "app" })).text, { timeout: 60_000 })
			.toContain("[another window]");
		const own = await call("ompdesk_sessions");
		expect(own.text).toContain("1 session in this window");
		expect(own.text).toContain("1 more open in other windows (scope app)");

		// Two attempts, judged against a criterion: the fake judge ranks them in evidence order. The second works in
		// a folder of its own, as a worktree child does, so its reopen below must go back there.
		const elsewhere = path.join(profile, "elsewhere");
		await fs.mkdir(elsewhere);
		const open = await call("ompdesk_session_open", {
			sessions: [
				{ message: "First attempt at the task" },
				{ message: "Second attempt at the task", folder: elsewhere },
			],
		});
		expect(open.isError, open.text).toBe(false);
		const [one, two] = opened(open.text);
		expect(one && two).toBeTruthy();
		const done = await call("ompdesk_session_result", { sessions: [one, two], wait: true, timeout_seconds: 60 });
		expect(done.text).toContain("Local fixture reply");
		const judged = await call("ompdesk_compare", { sessions: [one, two], criteria: ["answers the task"] });
		expect(judged.isError, judged.text).toBe(false);
		expect(judged.text).toContain("Verdict by fixture/judge:");
		expect(judged.text).toContain(`1. ${one}: 90/100`);
		expect(judged.text).toContain(`Winner: ${one}. fixture judge picks the first`);
		expect(judged.text).toContain("final answer: Local fixture reply");

		// Closed, it is still a saved session: found by its text, read without a tab, opened again.
		expect((await call("ompdesk_session_stop", { session: two, close: true })).isError).toBe(false);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).map(tab => tab.tabId))
			.not.toContain(two);
		let stored = "";
		await expect
			.poll(
				async () => {
					stored = (await call("ompdesk_sessions", { scope: "stored", query: "Second attempt" })).text;
					return stored;
				},
				{ timeout: 30_000 },
			)
			// The closed session's own row (the caller's journal now also mentions it: "Closed …").
			.toMatch(/\n- \S+ "Second attempt at the task"\n[^\n]*changed [^\n;]*\n/);
		const id = /\n- (\S+) "Second attempt at the task"/.exec(stored)?.[1] ?? "";
		expect(id).not.toBe("");
		const read = await call("ompdesk_session_read", { session: id });
		expect(read.isError, read.text).toBe(false);
		expect(read.text).toContain("(saved, not open)");
		expect(read.text).toContain("Second attempt at the task");
		expect(read.text).toContain("[assistant] Local fixture reply");
		const tabsBefore = (await page.evaluate(() => window.omp.tabs.list())).length;
		const reopened = await call("ompdesk_session_open", { reopen: id });
		expect(reopened.isError, reopened.text).toBe(false);
		expect(reopened.text).toContain("reopened");
		// In the folder its file records, not the caller's or the app's (v0.46.0 reopened one in the main checkout).
		expect(reopened.text).toContain(`in ${await fs.realpath(elsewhere)} (`);
		await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length).toBe(tabsBefore + 1);

		// Its folder removed with nothing saved: the reopen is refused, naming the folder, and opens no tab anywhere.
		const [again] = opened(reopened.text);
		expect((await call("ompdesk_session_stop", { session: again, close: true })).isError).toBe(false);
		await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length).toBe(tabsBefore);
		const home = await fs.realpath(elsewhere);
		await fs.rm(elsewhere, { recursive: true, force: true });
		const refused = await call("ompdesk_session_open", { reopen: id });
		expect(refused.text).toContain(`no longer exists (${home}) and nothing of it was saved`);
		expect((await page.evaluate(() => window.omp.tabs.list())).length).toBe(tabsBefore);
	});

	test("a saved session whose worktree disk care saved and removed is restored and reopened there", async () => {
		test.setTimeout(120_000);
		const call = await caller(page, record);
		const repo = await fs.realpath(path.join(profile, "project"));
		git(repo, "init", "-q", "-b", "main");
		git(repo, "commit", "-q", "--allow-empty", "-m", "init");
		const worktree = path.join(path.dirname(repo), "wt-saved");
		git(repo, "worktree", "add", "-q", "-b", "omp/agent/saved", worktree);
		const home = await fs.realpath(worktree);
		const open = await call("ompdesk_session_open", { message: "Work in the worktree", folder: home });
		const [child] = opened(open.text);
		await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });
		expect((await call("ompdesk_session_stop", { session: child, close: true })).isError).toBe(false);
		let stored = "";
		await expect
			.poll(async () => {
				stored = (await call("ompdesk_sessions", { scope: "stored", query: "Work in the worktree" })).text;
				return stored;
			})
			.toMatch(/\n- \S+ "Work in the worktree"/);
		const id = /\n- (\S+) "Work in the worktree"/.exec(stored)?.[1] ?? "";

		// What disk care leaves when it saves and removes an idle worktree: the record, then the folder gone.
		const head = git(home, "rev-parse", "HEAD");
		git(repo, "worktree", "remove", home);
		await fs.mkdir(path.join(profile, "desktop", "disk-care"), { recursive: true });
		const saved = {
			id: "saved1",
			path: home,
			repo,
			branch: "omp/agent/saved",
			head,
			savedBranch: null,
			removedAt: Date.now(),
			archivedFiles: 0,
			archivedBytes: 0,
		};
		await fs.writeFile(path.join(profile, "desktop", "disk-care", "saved.json"), JSON.stringify([saved]));

		// The agent is told the record and the way back, and nothing opens; restore puts the worktree back and opens
		// the session there. The window's toast and its Restore re-open are unit-tested (stores/tabs.test.tsx).
		const tabsBefore = (await page.evaluate(() => window.omp.tabs.list())).length;
		const refused = await call("ompdesk_session_open", { reopen: id });
		expect(refused.text).toContain("saved worktree saved1");
		expect(refused.text).toContain(`{"reopen":"${id}","restore":true}`);
		expect((await page.evaluate(() => window.omp.tabs.list())).length).toBe(tabsBefore);
		const restored = await call("ompdesk_session_open", { reopen: id, restore: true });
		expect(restored.isError, restored.text).toBe(false);
		expect(restored.text).toContain(`in ${home} (reopened)`);
		expect(git(home, "rev-parse", "--abbrev-ref", "HEAD")).toBe("omp/agent/saved");
	});
});

test.describe("on a paired device", () => {
	let parent: string;
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;

	test.beforeEach(async () => {
		parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-device-"));
	});

	test.afterEach(async () => {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	/**
	 * Two apps, the client paired to the host as "PC-B"; `call` runs a control tool as the client's focused tab.
	 * `blips`: the client reaches the host through a relay whose link the test can cut.
	 */
	async function pairApps(options: { blips?: boolean } = {}) {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const link: LinkProxy | undefined = options.blips ? await linkProxy(hostProfile.port) : undefined;
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: link ? Number(link.address.split(":")[1]) : hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const deviceId = await connectHost(host.page, client.page, "PC-B");
		const state = async () => (await client?.page.evaluate(() => window.omp.remote.getState()))?.hosts[0]?.state;
		await expect.poll(state, { timeout: 30_000 }).toBe("online");
		const call = await caller(client.page, clientProfile.record);
		return { hostProfile, clientProfile, deviceId, call, client, link, state };
	}

	test("keeps answering through a blip of the device's link: reads and lists wait for it to come back", async () => {
		test.setTimeout(240_000);
		const { call, link, state, client: app } = await pairApps({ blips: true });
		if (!link) throw new Error("no relay");
		const open = await call("ompdesk_session_open", { device: "PC-B", message: "Title: blip work\nWork there" });
		expect(open.isError, open.text).toBe(false);
		const [child] = opened(open.text);
		await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });

		/** `run` made while the link is down, which comes back 1.5 s later: it must wait for it, not fail. */
		const throughBlip = async (run: () => Promise<{ text: string; isError: boolean }>) => {
			await link.drop();
			await expect.poll(state, { timeout: 30_000 }).not.toBe("online");
			const pending = run();
			// A real wait: the call has to be in flight while the real link is down (a fake clock cannot stand in for
			// the reconnecting client and the relay).
			await app.page.waitForTimeout(1_500);
			await link.restore();
			return pending;
		};
		const read = await throughBlip(() => call("ompdesk_session_read", { session: child }));
		expect(read.isError, read.text).toBe(false);
		expect(read.text).toContain("Work there");
		const stored = await throughBlip(() => call("ompdesk_sessions", { scope: "stored", device: "PC-B" }));
		expect(stored.isError, stored.text).toBe(false);
		expect(stored.text).toContain("saved on PC-B");
		const result = await throughBlip(() => call("ompdesk_session_result", { session: "blip work" }));
		expect(result.isError, result.text).toBe(false);
		expect(result.text).toContain("Local fixture reply");
		await link.close();
	});

	test("opens a session on a paired device, waits for it there, and reads its saved transcript back", async () => {
		test.setTimeout(240_000);
		const { hostProfile, clientProfile, deviceId, call } = await pairApps();

		const listed = await call("ompdesk_sessions");
		expect(listed.text).toContain(`Paired devices: PC-B (id ${deviceId}, online)`);

		const open = await call("ompdesk_session_open", { device: "PC-B", message: "Run this on the other computer" });
		expect(open.isError, open.text).toBe(false);
		expect(open.text).toContain("on PC-B");
		const [child] = opened(open.text);
		const done = await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });
		expect(done.text).toContain("Local fixture reply");
		// The prompt ran on the device's omp, not this computer's.
		const prompted = (records: Record<string, unknown>[]) =>
			records.some(
				frame => frame.type === "prompt" && String(frame.message).includes("Run this on the other computer"),
			);
		expect(prompted(await readRecords(hostProfile.record))).toBe(true);
		expect(prompted(await readRecords(clientProfile.record))).toBe(false);
		expect((await call("ompdesk_sessions", { device: "PC-B" })).text).toContain(child as string);

		// Open in a tab, a saved session reads through that tab; closed, it is read from the device's own file.
		expect((await call("ompdesk_session_stop", { session: child, close: true })).isError).toBe(false);
		let stored = "";
		await expect
			.poll(
				async () => {
					stored = (await call("ompdesk_sessions", { scope: "stored", device: "PC-B", query: "other computer" }))
						.text;
					return stored;
				},
				{ timeout: 30_000 },
			)
			.toMatch(/saved on PC-B[^\n]*\n- \S+ "[^\n]*\n[^\n]*changed [^\n;]*\n/);
		const id = /\n- (\S+) "/.exec(stored)?.[1] ?? "";
		const read = await call("ompdesk_session_read", { session: id });
		expect(read.isError, read.text).toBe(false);
		expect(read.text).toContain("saved on PC-B");
		expect(read.text).toContain("Run this on the other computer");
		// Paged from its end: the cursor of the last page reads the one before.
		const last = await call("ompdesk_session_read", { session: id, limit: 1 });
		const cursor = /"before":"(\d+)"/.exec(last.text)?.[1];
		expect(cursor, last.text).toBeDefined();
		const earlier = await call("ompdesk_session_read", { session: id, limit: 1, before: cursor });
		expect(earlier.isError, earlier.text).toBe(false);
		expect(earlier.text).not.toBe(last.text);

		// Listed while open, the row names that tab; the device's close releases it at once, so the same row reopens.
		const reopened = await call("ompdesk_session_open", { reopen: id });
		expect(reopened.isError, reopened.text).toBe(false);
		expect(reopened.text).toContain("reopened");
		const [again] = opened(reopened.text);
		expect(
			(await call("ompdesk_sessions", { scope: "stored", device: "PC-B", query: "other computer" })).text,
		).toContain(`open in tab ${again}`);
		expect((await call("ompdesk_session_stop", { session: again, close: true })).isError).toBe(false);
		await expect
			.poll(async () =>
				(await client?.page.evaluate(() => window.omp.tabs.list()))?.some(tab => tab.tabId === again),
			)
			.toBe(false);
		const twice = await call("ompdesk_session_open", { reopen: id });
		expect(twice.isError, twice.text).toBe(false);
		const [third] = opened(twice.text);
		expect((await call("ompdesk_session_stop", { session: third, close: true })).isError).toBe(false);

		// A saved session no tab holds is deleted by its stored id and device, on the device.
		const deleted = await call("ompdesk_session_stop", { session: id, device: "PC-B", delete: true });
		expect(deleted.isError, deleted.text).toBe(false);
		expect(deleted.text).toContain("Deleted");
		await expect
			.poll(async () => (await call("ompdesk_sessions", { scope: "stored", device: "PC-B" })).text, {
				timeout: 30_000,
			})
			.not.toContain(id);
	});

	test("restores a worktree the paired device's disk care saved and reopens the session there", async () => {
		test.setTimeout(240_000);
		const { hostProfile, call } = await pairApps();
		const repo = hostProfile.project;
		git(repo, "init", "-q", "-b", "main");
		git(repo, "commit", "-q", "--allow-empty", "-m", "init");
		const worktree = path.join(path.dirname(repo), "wt-host");
		git(repo, "worktree", "add", "-q", "-b", "omp/agent/host", worktree);
		const home = await fs.realpath(worktree);
		const open = await call("ompdesk_session_open", { device: "PC-B", folder: home, message: "Host worktree work" });
		expect(open.isError, open.text).toBe(false);
		const [child] = opened(open.text);
		await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });
		expect((await call("ompdesk_session_stop", { session: child, close: true })).isError).toBe(false);
		let stored = "";
		await expect
			.poll(
				async () => {
					stored = (await call("ompdesk_sessions", { scope: "stored", device: "PC-B", query: "Host worktree" }))
						.text;
					return stored;
				},
				{ timeout: 30_000 },
			)
			.toMatch(/\n- \S+ "/);
		const id = /\n- (\S+) "/.exec(stored)?.[1] ?? "";

		// What the host's disk care leaves when it saves and removes an idle worktree: its record, the folder gone.
		const head = git(home, "rev-parse", "HEAD");
		git(repo, "worktree", "remove", home);
		await fs.mkdir(path.join(hostProfile.desktop, "disk-care"), { recursive: true });
		const saved = {
			id: "hostsaved",
			path: home,
			repo,
			branch: "omp/agent/host",
			head,
			savedBranch: null,
			removedAt: Date.now(),
			archivedFiles: 0,
			archivedBytes: 0,
		};
		await fs.writeFile(path.join(hostProfile.desktop, "disk-care", "saved.json"), JSON.stringify([saved]));

		const refused = await call("ompdesk_session_open", { reopen: id });
		expect(refused.text).toContain("saved worktree hostsaved");
		expect(refused.text).toContain(`{"reopen":"${id}","restore":true}`);
		const restored = await call("ompdesk_session_open", { reopen: id, restore: true });
		expect(restored.isError, restored.text).toBe(false);
		expect(restored.text).toContain(`in ${home} on PC-B (reopened)`);
		expect(git(home, "rev-parse", "--abbrev-ref", "HEAD")).toBe("omp/agent/host");
	});

	test("shows, notifies and reports from a session that runs on the paired device", async () => {
		test.setTimeout(240_000);
		const { hostProfile, call, client: app } = await pairApps();
		const parentTab = (await app.page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		const open = await call("ompdesk_session_open", { device: "PC-B", message: "Title: remote part\nDo it there" });
		expect(open.isError, open.text).toBe(false);
		const [child] = opened(open.text);
		await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });

		// ompdesk_tab_focus: the device's tab comes to the front of this window.
		expect((await call("ompdesk_tab_focus", { session: child })).isError).toBe(false);
		await expect
			.poll(async () => (await app.page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId)
			.toBe(child);

		// The child runs on the host's omp; its control tools are answered here, as this computer's tab.
		const asChild = await caller(app.page, hostProfile.record, child);
		const notified = await asChild("ompdesk_notify", { title: "From PC-B", body: "done there" });
		expect(notified.isError, notified.text).toBe(false);
		const report = await asChild("ompdesk_report", { kind: "done", text: "Finished on PC-B", dispatch: "d1" });
		expect(report.isError, report.text).toBe(false);
		expect(report.text).not.toContain("not opened");
		// The report reaches the opener on this computer as one mail in its transcript, closed until pressed.
		expect((await call("ompdesk_tab_focus", { session: parentTab })).isError).toBe(false);
		const mail = app.page.locator("[data-agent-mail='done']").last();
		await expect(mail).toBeVisible({ timeout: 30_000 });
		await mail.locator("button[aria-expanded]").click();
		await expect(mail).toContainText("Finished on PC-B");
		// The board docks beside the transcript only with room for it (`workBoardFits`).
		await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900));
		// The opener's work board lists it like a local child: one opened-session row with its status, the device's
		// name and its last report.
		const row = app.page.locator(`[data-board-section="opened"] [data-board-opened="${child}"]`);
		await expect(row).toBeVisible({ timeout: 30_000 });
		await expect(row).toHaveAttribute("data-board-report", "done");
		await expect(row.locator("[data-board-device]")).toHaveText("PC-B");
		// In the sidebar it is the opener's child, not a row of PC-B's own list.
		const hostList = app.page.locator(
			"[data-sidebar-device] [data-device-session], [data-sidebar-device] [data-session-path]",
		);
		await expect(hostList.filter({ hasText: "remote part" })).toHaveCount(0);
	});

	test("tells the opener when its session on the paired device shows a question card, and the answer reaches it", async () => {
		test.setTimeout(240_000);
		const { hostProfile, clientProfile, call, client: app } = await pairApps();
		const parentTab = (await app.page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		const open = await call("ompdesk_session_open", { device: "PC-B", message: "Title: ask there\nAsk me" });
		expect(open.isError, open.text).toBe(false);
		const [child] = opened(open.text);
		await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });
		// The host's omp raises a stock `ask` card (the fake's "fixture ask").
		await app.page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture ask" }),
			child as string,
		);
		// Nobody polls: the opener's omp on this computer gets one question mail naming the card, between its steps.
		const mails = async () =>
			(await readRecords(clientProfile.record)).filter(
				frame =>
					frame.type === "agent_control.mail" &&
					(frame.details as Record<string, unknown> | undefined)?.kind === "question" &&
					(frame.details as Record<string, unknown> | undefined)?.from === child,
			);
		await expect.poll(async () => (await mails()).length, { timeout: 30_000 }).toBe(1);
		const [mail] = await mails();
		expect(mail?.deliverAs).toBe("aside");
		expect(mail?.triggerTurn).toBe(true);
		expect(String(mail?.content)).toContain("Where should this deploy?");
		expect(String(mail?.content)).toContain("ompdesk_session_answer");
		expect((await readRecords(hostProfile.record)).some(frame => frame.type === "agent_control.mail")).toBe(false);
		expect((await call("ompdesk_tab_focus", { session: parentTab })).isError).toBe(false);
		await expect(app.page.locator("[data-agent-mail='question']").last()).toBeVisible({ timeout: 30_000 });

		// Answered by the opener's tool on this computer: the answer reaches the card on the host's omp.
		const answered = await call("ompdesk_session_answer", {
			session: child,
			answers: [
				{ id: "env", selected: ["Staging"] },
				{ id: "checks", selected: ["Lint"] },
				{ id: "notify", selected: ["No"] },
			],
		});
		expect(answered.isError, answered.text).toBe(false);
		await expect
			.poll(async () =>
				(await readRecords(hostProfile.record)).some(
					frame => frame.type === "extension_ui_response" && frame.id === "fixture-ask",
				),
			)
			.toBe(true);
		expect((await mails()).length).toBe(1);
	});

	test("the opener's board and sidebar follow a session running on the paired device, live", async () => {
		test.setTimeout(240_000);
		const { hostProfile, call, client: app } = await pairApps();
		await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900));
		const parentTab = (await app.page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		const open = await call("ompdesk_session_open", { device: "PC-B" });
		expect(open.isError, open.text).toBe(false);
		const [child] = opened(open.text);
		// A turn that stays open on the host's omp (the fake holds "fixture running" until `fixture:finish`).
		await app.page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
			child as string,
		);

		const row = app.page.locator(`[data-board-section="opened"] [data-board-opened="${child}"]`);
		await expect(row).toHaveAttribute("data-status", "running", { timeout: 30_000 });
		await expect(row.locator("[data-board-device]")).toHaveText("PC-B");
		// Its clock runs while the turn on the host does.
		await expect(row).toContainText(/\d+s/, { timeout: 15_000 });
		// The opener's sidebar row counts it among its children at work, and the opener's title sweeps (background).
		const opener = app.page.locator(".omp-sidebar-session-row", { has: app.page.locator("[data-family-running]") });
		await expect(opener.locator("[data-family-running]")).toHaveText("1", { timeout: 30_000 });
		await expect(opener.locator("[data-working]")).toHaveCount(1);

		// A report from the child on the host shows on the row while it still runs.
		const asChild = await caller(app.page, hostProfile.record, child);
		const report = await asChild("ompdesk_report", { kind: "progress", text: "Halfway on PC-B", dispatch: "d1" });
		expect(report.isError, report.text).toBe(false);
		await expect(row).toHaveAttribute("data-board-report", "progress", { timeout: 30_000 });
		// One line per row: the report is the row's tooltip.
		await expect(row).toHaveAttribute("title", /Halfway on PC-B/);

		// The turn on the host ends: the row stops running and folds into the finished children's "1 done" row.
		await app.page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:finish" }),
			child as string,
		);
		await expect(app.page.locator('[data-board-section="opened"] [data-board-opened-done]')).toHaveText("1 done", {
			timeout: 30_000,
		});
		await expect(row).toHaveCount(0);
		expect(parentTab).not.toBe(child);
	});

	test("the board keeps a running remote child's clock, and the child running, across a link blip", async () => {
		test.setTimeout(240_000);
		const { call, link, state, client: app } = await pairApps({ blips: true });
		if (!link) throw new Error("no relay");
		await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900));
		const open = await call("ompdesk_session_open", { device: "PC-B" });
		expect(open.isError, open.text).toBe(false);
		const [child] = opened(open.text);
		await app.page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
			child as string,
		);
		const row = app.page.locator(`[data-board-section="opened"] [data-board-opened="${child}"]`);
		await expect(row).toHaveAttribute("data-status", "running", { timeout: 30_000 });
		const seconds = async (): Promise<number | null> => {
			const text = (await row.textContent()) ?? "";
			const clock = /(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s/.exec(text);
			if (!clock) return null;
			return Number(clock[1] ?? 0) * 3600 + Number(clock[2] ?? 0) * 60 + Number(clock[3]);
		};
		await expect.poll(seconds, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
		const before = (await seconds()) ?? 0;
		const shots = process.env.OMP_GUI_REALTIME_BOARD;
		if (shots) await app.page.screenshot({ path: path.join(shots, "remote-child-before-blip.png") });

		// The link drops and comes back while the host's omp keeps the turn going.
		await link.drop();
		await expect.poll(state, { timeout: 30_000 }).not.toBe("online");
		await expect
			.poll(
				async () =>
					(await app.page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === child)?.status,
				{
					timeout: 30_000,
				},
			)
			.not.toBe("running");
		await link.restore();
		await expect.poll(state, { timeout: 60_000 }).toBe("online");

		// The tab still runs, and its clock goes on from where it was (the turn's start, not the re-attach).
		await expect
			.poll(
				async () =>
					(await app.page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === child)?.status,
				{
					timeout: 30_000,
				},
			)
			.toBe("running");
		await expect(row).toHaveAttribute("data-status", "running");
		await expect.poll(seconds, { timeout: 15_000 }).toBeGreaterThan(before);
		if (shots) await app.page.screenshot({ path: path.join(shots, "remote-child-after-blip.png") });

		// The turn ends on the host: the row stops running and folds into the "1 done" row.
		await app.page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:finish" }),
			child as string,
		);
		await expect(app.page.locator('[data-board-section="opened"] [data-board-opened-done]')).toHaveText("1 done", {
			timeout: 30_000,
		});
		await expect(row).toHaveCount(0);
	});

	test("creates, lists and cancels a schedule on a paired device, which keeps and runs it", async () => {
		test.setTimeout(180_000);
		const { hostProfile, clientProfile, deviceId, call, client: app } = await pairApps();
		const hostSchedules = async (): Promise<unknown[]> => {
			const saved: unknown = JSON.parse(
				await fs.readFile(path.join(hostProfile.desktop, "schedules.json"), "utf8").catch(() => "{}"),
			);
			return typeof saved === "object" && saved !== null && "schedules" in saved && Array.isArray(saved.schedules)
				? saved.schedules
				: [];
		};
		// Settings › Schedules of a tab on the host hears the host's own changes: each push's count, in order.
		await app.page.evaluate(id => {
			window.omp.schedules.onHostState((from, state) => {
				if (from !== id) return;
				document.body.dataset.schedulePushes = `${document.body.dataset.schedulePushes ?? ""}${state.schedules.length}`;
			});
		}, deviceId);

		const created = await call("ompdesk_schedule", {
			action: "create",
			device: "PC-B",
			name: "nightly",
			prompt: "Say OK.",
			every_minutes: 60,
			folder: hostProfile.project,
		});
		expect(created.isError, created.text).toBe(false);
		expect(created.text).toContain("on PC-B");
		const id = /; id (\S+);/.exec(created.text)?.[1] ?? "";
		// The host keeps it in its own schedules.json and runs it; this computer has none.
		await expect
			.poll(hostSchedules)
			.toEqual([
				expect.objectContaining({ id, name: "[agent] nightly", cwd: hostProfile.project, autoApprove: false }),
			]);
		expect(
			await fs.readFile(path.join(clientProfile.desktop, "schedules.json"), "utf8").catch(() => ""),
		).not.toContain(id);

		const listed = await call("ompdesk_schedule", { action: "list", device: "PC-B" });
		expect(listed.text).toContain(`Scheduled runs on PC-B:\n- ${id} “[agent] nightly” every 60 min`);
		// Settings reads the same list from the host through the device-routed channel.
		const settings = await app.page.evaluate(
			device => window.omp.schedules.command({ action: "get" }, device),
			deviceId,
		);
		expect(settings.schedules.map(schedule => schedule.id)).toEqual([id]);

		const cancelled = await call("ompdesk_schedule", { action: "cancel", id, device: "PC-B" });
		expect(cancelled.text).toBe("Cancelled “[agent] nightly” on PC-B.");
		await expect.poll(hostSchedules).toEqual([]);
		await expect.poll(() => app.page.evaluate(() => document.body.dataset.schedulePushes)).toMatch(/1.*0$/);
	});

	test("opens a worktree session on a paired device, then compares and merges it there", async () => {
		test.setTimeout(240_000);
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const repo = hostProfile.project;
		git(repo, "init", "-q", "-b", "main");
		// Git for Windows ships core.autocrlf=true in its system config: the merge would write remote.txt with CRLF.
		git(repo, "config", "core.autocrlf", "false");
		await fs.writeFile(path.join(repo, "README.md"), "hello\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		await connectHost(host.page, client.page, "PC-B");
		await expect
			.poll(async () => (await client?.page.evaluate(() => window.omp.remote.getState()))?.hosts[0]?.state, {
				timeout: 30_000,
			})
			.toBe("online");
		const call = await caller(client.page, clientProfile.record);

		// ompdesk_session_open: the worktree is made on the device, beside its repository, and the tab opens in it.
		const open = await call("ompdesk_session_open", {
			device: "PC-B",
			folder: repo,
			worktree: true,
			message: "Change it on the other computer",
		});
		expect(open.isError, open.text).toBe(false);
		const [child] = opened(open.text);
		const tab = (await client.page.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === child);
		const worktree = tab?.worktree;
		expect(worktree?.baseCwd).toBe(repo);
		// Named by the device's stock worktree location (its agent dir's `wt`, the fake omp's), not this computer's.
		expect(worktree?.path.startsWith(path.join(hostProfile.root, "agent", "wt", "gui-"))).toBe(true);
		expect(git(repo, "worktree", "list", "--porcelain")).toContain(`branch refs/heads/${worktree?.branch}`);
		expect(
			(await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 })).text,
		).toContain("Local fixture reply");

		// The fake child does not edit: commit in its checkout on the device the way a real child's work lands.
		const checkout = worktree?.path ?? "";
		await fs.writeFile(path.join(checkout, "remote.txt"), "made on PC-B\n");
		git(checkout, "add", "remote.txt");
		git(checkout, "commit", "-q", "-m", "add remote.txt");

		// ompdesk_compare reads the branch with the device's git.
		const compared = await call("ompdesk_compare", { sessions: [child] });
		expect(compared.isError, compared.text).toBe(false);
		expect(compared.text).toContain(
			`branch ${worktree?.branch} → main: 1 commit(s) ahead, 1 file(s) changed (+1 −0)`,
		);
		expect(compared.text).toContain("ready to merge with ompdesk_merge");

		// ompdesk_merge merges into the device's parent checkout, never pushed.
		const merged = await call("ompdesk_merge", { session: child });
		expect(merged.isError, merged.text).toBe(false);
		expect(merged.text).toContain(`Merged ${worktree?.branch} into ${repo}`);
		expect(merged.text).toContain("Nothing was pushed");
		expect(await fs.readFile(path.join(repo, "remote.txt"), "utf8")).toBe("made on PC-B\n");
		expect(git(repo, "log", "-1", "--format=%s")).toContain(`Merge ${worktree?.branch} into main`);
	});
});
