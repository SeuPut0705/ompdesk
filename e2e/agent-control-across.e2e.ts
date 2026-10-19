import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { controlToolCaller as caller, exitApp, launchApp, openedSessions as opened, readRecords } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

// OMPdesk control tools beyond the caller's window (src/main/agent-control): another window's sessions, saved
// sessions read and reopened without a tab, a judged compare of two sessions, and sessions on a paired device: one
// opened there whose prompt runs on that device's omp, whose saved transcript is read back (paged), reopened after its
// tab closed and deleted by its saved id; and one that is shown, notifies and reports to its opener across the link.
// The fake omp calls
// a tool with `fixture:host-tool:<name> <json>` and records the `host_tool_result` it gets; its judge
// (`agent_control.judge`) ranks the sessions in evidence order. The rules behind each answer are unit-tested in
// src/main/agent-control/service.test.ts and host.test.ts.

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
				batchNotifications: false,
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

		// Two attempts, judged against a criterion: the fake judge ranks them in evidence order.
		const open = await call("ompdesk_session_open", {
			sessions: [{ message: "First attempt at the task" }, { message: "Second attempt at the task" }],
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
		await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length).toBe(tabsBefore + 1);
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

	/** Two apps, the client paired to the host as "PC-B"; `call` runs a control tool as the client's focused tab. */
	async function pairApps() {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
			prefs: { batchNotifications: false },
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const deviceId = await connectHost(host.page, client.page, "PC-B");
		await expect
			.poll(async () => (await client?.page.evaluate(() => window.omp.remote.getState()))?.hosts[0]?.state, {
				timeout: 30_000,
			})
			.toBe("online");
		const call = await caller(client.page, clientProfile.record);
		return { hostProfile, clientProfile, deviceId, call, client };
	}

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
		// The report reaches the opener on this computer as one mail in its transcript.
		expect((await call("ompdesk_tab_focus", { session: parentTab })).isError).toBe(false);
		await expect(app.page.locator("[data-agent-mail='done']").filter({ hasText: "Finished on PC-B" })).toBeVisible({
			timeout: 30_000,
		});
	});
});
