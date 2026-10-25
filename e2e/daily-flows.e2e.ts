/**
 * Daily flows: features chained the way a person uses them in a day, each one test on the fake omp, asserting what
 * the user sees (no stale rows, no duplicate sessions, no lost text, no stuck spinners) and that no profile's
 * gui-runtime.jsonl holds an error line (e2e/runtime-errors.ts).
 *
 * (a) a quit mid-turn with subagents and a background job, then a relaunch that resumes it as one session;
 * (b) two worktree children opened by the main agent, one merged and one deleted, nothing left behind;
 * (c) a paired host's question across a cut link, answered on the device, then the device deletes the session;
 * (d) the phone page: a notification click, a steer during a turn, a reload that keeps the draft;
 * (e) a 3-pane split losing sessions to deletes, across relaunches;
 * (f) theme, language and model switches, the diagnostics bundle, Autopilot on and off.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import JSZip from "jszip";
import { _electron as electron } from "playwright";
import {
	activeTools,
	cleanupAp,
	command,
	launchAp,
	mainTab,
	makeApProfile,
	recorded,
	startFromSheet,
	waitForStatus,
} from "./autopilot-harness";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
import {
	controlToolCaller,
	cssString,
	exitApp,
	fixtureOmp,
	launchApp,
	openedSessions,
	pressShortcutUntilVisible,
	readRecords,
} from "./harness";
import {
	connectHost,
	freePort,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
} from "./remote-harness";
import { expectNoRuntimeErrors } from "./runtime-errors";

// The phone page (flow d) answers through a host round trip; the default 10 s per action is tight there.
test.use({ actionTimeout: 30_000 });

// ── Flow (a) ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Daily flow (a): a turn that fanned out subagents and a background job is cut by a normal quit, and the next
 * launch on the same profile continues it as the one session it was: one resuming row, one session file, one
 * sidebar row, the prompt once, no stuck spinner.
 */
const FLOW_A_PROMPT = "fixture running with job";

interface FlowAProfile {
	root: string;
	desktop: string;
	agent: string;
	env: Record<string, string>;
}

async function flowAProfile(): Promise<FlowAProfile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-daily-a-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
		OMP_GUI_TEST_JOB_TREE: "1",
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, desktop, agent, env };
}

async function flowALaunch(profile: FlowAProfile, ready: boolean): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	if (ready) {
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
	}
	return { app, page };
}

async function flowAMarkers(profile: FlowAProfile): Promise<Array<{ reason: string; sessionPath: string }>> {
	try {
		return JSON.parse(await fs.readFile(path.join(profile.desktop, "interrupted-turns.json"), "utf8"));
	} catch {
		return [];
	}
}

async function flowASessionFiles(profile: FlowAProfile): Promise<string[]> {
	const root = path.join(profile.agent, "sessions");
	const names = await fs.readdir(root, { recursive: true }).catch(() => []);
	return names.filter(name => name.endsWith(".jsonl")).map(name => path.join(root, name));
}

async function flowALayoutHasSession(profile: FlowAProfile): Promise<boolean> {
	try {
		const prefs = JSON.parse(await fs.readFile(path.join(profile.desktop, "prefs.json"), "utf8")) as {
			tabLayouts?: Array<{ tabs: Array<{ sessionPath?: string }> }>;
		};
		return prefs.tabLayouts?.some(layout => layout.tabs.some(tab => tab.sessionPath !== undefined)) === true;
	} catch {
		return false;
	}
}

test("daily flow a: a quit mid-turn with subagents and a background job resumes as one session", async () => {
	test.setTimeout(240_000);
	const profile = await flowAProfile();
	let current: ElectronApplication | undefined;
	try {
		let sessionPath = "";
		await test.step("new session: prompt, subagent roster and background jobs appear", async () => {
			const first = await flowALaunch(profile, true);
			current = first.app;
			const { page } = first;
			const input = page.locator(".omp-composer-input").first();
			await input.fill(FLOW_A_PROMPT);
			await input.press("Enter");
			await expect.poll(() => flowAMarkers(profile), { timeout: 30_000 }).toMatchObject([{ reason: "running" }]);
			await expect.poll(() => flowALayoutHasSession(profile), { timeout: 30_000 }).toBe(true);
			sessionPath = (await flowAMarkers(profile))[0]?.sessionPath ?? "";
			expect(sessionPath).not.toBe("");

			const roster = await page.evaluate(() =>
				window.omp.rpc.command({ type: "bash", command: "fixture:subagents" }),
			);
			expect(roster.success).toBe(true);
			// The work board lists both subagents and the shell: docked beside the transcript (the default window docks
			// it beside a narrowed column), else in the status strip, opened.
			const docked = page.locator(".omp-work-board-slot [data-work-board-panel]");
			const strip = page.locator("[data-work-chip]");
			await expect(docked.or(strip).first()).toBeVisible({ timeout: 15_000 });
			const inStrip = (await docked.count()) === 0;
			if (inStrip) await strip.click();
			const panel = inStrip ? page.locator("[data-work-strip-panel]") : docked;
			await expect(panel.locator("[data-board-agent]")).toHaveCount(2, { timeout: 15_000 });
			await expect(panel.locator("[data-board-job]").first()).toBeVisible();
			if (inStrip) await strip.click();
			await expect(page.locator("[data-sidebar-subagents-toggle]")).toHaveCount(1);
			await expect(page.locator(".omp-user-bubble")).toHaveText([new RegExp(`^${FLOW_A_PROMPT}`)]);
			await expect(page.locator(".omp-session-sidebar .omp-sidebar-session-row[data-session-path]")).toHaveCount(1);
		});

		await test.step("normal approved quit mid-turn keeps the marker", async () => {
			const app = current as ElectronApplication;
			await app.evaluate(({ app: electronApp, dialog }) => {
				dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
				setImmediate(() => electronApp.quit());
			});
			const child = app.process();
			await new Promise<void>(resolve => {
				if (child.exitCode !== null || child.signalCode !== null) resolve();
				else child.once("exit", () => resolve());
			});
			current = undefined;
			expect(await flowAMarkers(profile)).toMatchObject([{ reason: "running", sessionPath }]);
			await expectNoRuntimeErrors(profile.desktop);
		});

		await test.step("relaunch: one resuming row, then the turn ends", async () => {
			const second = await flowALaunch(profile, false);
			current = second.app;
			const { page } = second;
			await page.evaluate(() => {
				const probe = { rows: 0 };
				(window as unknown as { __flowAProbe: typeof probe }).__flowAProbe = probe;
				const scan = () => {
					probe.rows = Math.max(probe.rows, document.querySelectorAll("[data-resuming]").length);
				};
				scan();
				new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
			});
			await expect(page.getByText("Continued after the interruption.")).toBeVisible({ timeout: 45_000 });
			await expect(page.locator("[data-resuming]")).toHaveCount(0, { timeout: 15_000 });
			const rows = await page.evaluate(
				() => (window as unknown as { __flowAProbe: { rows: number } }).__flowAProbe.rows,
			);
			expect(rows, "exactly one resuming row was shown").toBe(1);
			await expect.poll(() => flowAMarkers(profile), { timeout: 15_000 }).toEqual([]);

			await expect(page.locator(".omp-user-bubble")).toHaveText([new RegExp(`^${FLOW_A_PROMPT}`)]);
			await expect(page.getByText("Continued after the interruption.")).toHaveCount(1);
			expect(await flowASessionFiles(profile)).toEqual([sessionPath]);
			const prompts = (await fs.readFile(sessionPath, "utf8")).split(FLOW_A_PROMPT).length - 1;
			expect(prompts, "the prompt is journaled once").toBe(1);

			await expect
				.poll(
					() =>
						page
							.locator(".omp-session-sidebar .omp-sidebar-session-row[data-session-path]")
							.evaluateAll(els => els.map(el => el.getAttribute("data-session-path"))),
					{ timeout: 15_000 },
				)
				.toEqual([sessionPath]);
			await expect(page.locator("[data-sidebar-subagents-toggle]")).toHaveCount(0);
			await expect(page.locator(".omp-session-sidebar [data-live]")).toHaveCount(0, { timeout: 15_000 });
			await expect(page.locator('[role="progressbar"], .omp-spinner')).toHaveCount(0);
			await expectNoRuntimeErrors(profile.desktop);
		});
		await test.step("a further relaunch resumes nothing and keeps the one session", async () => {
			await exitApp(current as ElectronApplication);
			current = undefined;
			const third = await flowALaunch(profile, true);
			current = third.app;
			const { page } = third;
			await expect(page.getByText("Continued after the interruption.")).toHaveCount(1, { timeout: 15_000 });
			await expect(page.locator("[data-resuming]")).toHaveCount(0);
			await expect(page.locator(".omp-user-bubble")).toHaveText([new RegExp(`^${FLOW_A_PROMPT}`)]);
			await expect(page.locator(".omp-session-sidebar .omp-sidebar-session-row[data-session-path]")).toHaveCount(1);
			expect(await flowAMarkers(profile)).toEqual([]);
			expect(await flowASessionFiles(profile)).toEqual([sessionPath]);
			await expectNoRuntimeErrors(profile.desktop);
		});
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

// ── Flow (b) ────────────────────────────────────────────────────────────────────────────────────────────────────
// Flow b: the main agent fans out two worktree children, both commit and finish, then it merges one and deletes
// the other with the control tools. Real git, fake omp. Nothing finished stays listed, the merged worktree goes
// with its auto-close, the deleted unlanded one is kept and said so, and a relaunch revives nothing.

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};
const flowBGit = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
// The app's git runs under the machine's config (Git for Windows' system `core.autocrlf=true` writes CRLF checkouts),
// so a status read under GIT_ENV's isolation calls a merged file modified: the final status is read the app's way.
const flowBStatus = (cwd: string) =>
	execFileSync("git", ["status", "--porcelain"], { cwd, env: process.env, encoding: "utf8" }).trim();

const flowBExists = (target: string) =>
	fs.stat(target).then(
		() => true,
		() => false,
	);

interface FlowBLaunched {
	app: ElectronApplication;
	page: Page;
	call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

async function flowBLaunch(root: string): Promise<FlowBLaunched> {
	const app = await launchApp({
		project: path.join(root, "project"),
		desktop: path.join(root, "desktop"),
		agent: path.join(root, "agent"),
		profile: root,
		env: {
			OMP_GUI_HEADLESS: "1",
			OMP_GUI_TEST_RECORD: path.join(root, "rpc.jsonl"),
			OMP_GUI_TEST_AGENT_SWEEP_MS: "500",
			OMP_GUI_TEST_SESSION_FILES: "1",
		},
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	return { app, page, call: await controlToolCaller(page, path.join(root, "rpc.jsonl")) };
}

// The merged child auto-closed: main records it under its opener, whose board folds it into its "1 done" row (no tab,
// no sidebar row; unfolded, a stored "done" row). The deleted one appears nowhere. After a relaunch the opener is a new
// session, so nothing is listed.
async function flowBExpectClean(page: Page, merged: boolean): Promise<void> {
	await expect(page.locator("[data-sidebar-opened-session]")).toHaveCount(0);
	await expect(page.locator('[data-board-section="review"]')).toHaveCount(0);
	const rows = page.locator('[data-board-section="now"] [data-board-opened]');
	const fold = page.locator('[data-board-section="now"] [data-board-opened-done]');
	await expect(rows).toHaveCount(0);
	if (merged) {
		await expect(fold).toHaveText("1 done");
		await fold.click();
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toHaveAttribute("data-status", "done");
		await expect(rows.first()).toContainText("flow b merge me");
	} else await expect(fold).toHaveCount(0);
	// The opener's transcript may say it deleted the session (a mail note); no list or row may.
	const lists = [
		...(await page.locator('[data-board-section="now"]').allInnerTexts()),
		...(await page.locator("aside, nav").allInnerTexts()),
	];
	for (const text of lists) {
		expect(text).not.toContain("flow b drop me");
		expect(text).not.toMatch(/gui-agent|\(untitled\)/);
	}
}

test("daily flow b: merge one worktree child, delete the other; nothing lingers, also after a relaunch", async () => {
	test.setTimeout(300_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-daily-b-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(path.join(root, "agent"))]);
	flowBGit(project, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(project, "README.md"), "hello\n");
	flowBGit(project, "add", ".");
	flowBGit(project, "commit", "-q", "-m", "init");
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const pageErrors: string[] = [];
	let launched = await flowBLaunch(root);
	launched.page.on("pageerror", error => pageErrors.push(error.message));
	try {
		let { page, call } = launched;
		const tabs = () => page.evaluate(() => window.omp.tabs.list());
		const main = (await tabs()).find(tab => tab.active)?.tabId ?? "";
		expect(main).not.toBe("");
		let kept: { path: string; branch: string } | undefined;
		let merged: { path: string; branch: string } | undefined;
		let mergedTab = "";
		let deletedId = "";

		await test.step("the main agent opens two worktree children that finish ok", async () => {
			const opened = await call("ompdesk_session_open", {
				sessions: [
					{ message: "Title: flow b merge me\nfixture:result-ok", worktree: true },
					{ message: "Title: flow b drop me\nfixture:result-ok", worktree: true },
				],
			});
			expect(opened.isError, opened.text).toBe(false);
			const ids = openedSessions(opened.text);
			expect(ids).toHaveLength(2);
			const children = (await tabs()).filter(tab => tab.tabId !== main && tab.worktree);
			expect(children).toHaveLength(2);
			const one = children.find(tab => tab.tabId === ids[0]);
			const two = children.find(tab => tab.tabId === ids[1]);
			if (!one || !two) throw new Error("opened ids do not match the tabs");
			merged = { path: one.worktree?.path ?? "", branch: one.worktree?.branch ?? "" };
			kept = { path: two.worktree?.path ?? "", branch: two.worktree?.branch ?? "" };
			deletedId = two.tabId;
			await call("ompdesk_session_result", {
				sessions: [one.tabId, two.tabId],
				wait: true,
				timeout_seconds: 90,
			});
			for (const [child, file] of [
				[merged, "part-merge.txt"],
				[kept, "part-drop.txt"],
			] as const) {
				await fs.writeFile(path.join(child.path, file), `work of ${file}\n`);
				flowBGit(child.path, "add", file);
				flowBGit(child.path, "commit", "-q", "-m", `add ${file}`);
			}
			mergedTab = one.tabId;
		});
		if (!merged || !kept) throw new Error("children were not opened");

		await test.step("the agent merges one and deletes the other", async () => {
			const landed = await call("ompdesk_merge", { session: mergedTab });
			expect(landed.isError, landed.text).toBe(false);
			expect(await fs.readFile(path.join(project, "part-merge.txt"), "utf8")).toContain("work of part-merge.txt");

			const removed = await call("ompdesk_session_stop", { session: deletedId, delete: true });
			expect(removed.isError, removed.text).toBe(false);
			expect(removed.text).toContain("deleted");
			// Unlanded commit: the worktree and branch stay and the result names them.
			expect(removed.text).toContain(kept?.path);
			expect(removed.text).toContain(kept?.branch);
			expect(removed.text).not.toContain("Removed its worktree");
		});

		await test.step("the merged worktree is removed, the unlanded one kept; the UI lists no child", async () => {
			await expect
				.poll(async () => (await tabs()).some(tab => tab.tabId === mergedTab), { timeout: 60_000 })
				.toBe(false);
			await expect.poll(() => flowBExists(merged?.path ?? ""), { timeout: 30_000 }).toBe(false);
			expect(flowBGit(project, "branch", "--list", merged?.branch ?? "")).toBe("");
			expect((await tabs()).some(tab => tab.tabId === deletedId)).toBe(false);
			expect(await flowBExists(kept?.path ?? "")).toBe(true);
			expect(flowBGit(project, "branch", "--list", kept?.branch ?? "")).toContain(kept?.branch);
			// git lists `C:/x/wt`, the app and `path` spell it `C:\x\wt`: compare the normalized paths.
			const worktrees = flowBGit(project, "worktree", "list", "--porcelain")
				.split(/\r?\n/)
				.filter(line => line.startsWith("worktree "))
				.map(line => path.normalize(line.slice("worktree ".length)));
			expect(worktrees).not.toContain(path.normalize(merged?.path ?? ""));
			expect(worktrees).toContain(path.normalize(kept?.path ?? ""));
			expect(flowBStatus(project)).toBe("");
			await expect.poll(async () => (await tabs()).length).toBe(1);
			await flowBExpectClean(page, true);
		});

		await test.step("after a relaunch no ghost row and no revived session", async () => {
			await exitApp(launched.app);
			await expectNoRuntimeErrors(desktop);
			launched = await flowBLaunch(root);
			launched.page.on("pageerror", error => pageErrors.push(error.message));
			({ page, call } = launched);
			await expect.poll(async () => (await tabs()).length).toBe(1);
			await page.waitForTimeout(2_000);
			expect((await tabs()).length).toBe(1);
			await flowBExpectClean(page, false);
			expect(await flowBExists(merged?.path ?? "")).toBe(false);
			expect(flowBGit(project, "branch", "--list", merged?.branch ?? "")).toBe("");
			expect(await flowBExists(kept?.path ?? "")).toBe(true);
			const stored = await call("ompdesk_sessions", { scope: "window" });
			expect(stored.text).not.toContain("flow b drop me");
		});

		expect(pageErrors).toEqual([]);
	} finally {
		await exitApp(launched.app);
		await expectNoRuntimeErrors(desktop);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

// ── Flow (c) ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Daily flow (c): a question raised by a paired host's omp, across a cut link, answered on the device, then the
 * device deletes the hosted session. Two instances on the fake omp (remote-harness.ts).
 */
async function flowCSend(page: Page, text: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(text);
	await input.press("Enter");
}

async function flowCStatus(page: Page, deviceId: string): Promise<string | undefined> {
	return (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.device === deviceId)?.status;
}

test("daily flow c: a host's question survives a cut link, is answered on the device, and the device deletes the session", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-daily-c-")));
	const hostPort = await freePort();
	const proxy = await linkProxy(hostPort);
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", { language: "en", theme: "light", port: hostPort });
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: Number(proxy.address.split(":")[1]),
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		const b = host.page;
		const clientApp = client.app;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "Host B");
		await openHostFolder(a, deviceId, hostProfile.project);

		const prompt = a.locator("[data-prompt-card]");
		const card = prompt.filter({ hasText: "Where should this deploy?" });
		const reconnecting = a.locator(`[data-remote-reconnecting="${deviceId}"]`);
		const openAsks = () => a.evaluate(() => window.omp.ui.openRequests().then(open => open.map(o => o.request.id)));
		const answered = a.getByText("Answered on another device");

		await test.step("the host's omp asks: the card shows on the device", async () => {
			await flowCSend(a, "fixture ask");
			await expect(card).toBeVisible({ timeout: 30_000 });
			await expect(card).toHaveCount(1);
			expect(await openAsks()).toEqual(["fixture-ask"]);
		});

		await test.step("the link is cut and restored: the same card is back exactly once", async () => {
			await proxy.drop();
			await expect(reconnecting).toBeVisible({ timeout: 30_000 });
			await proxy.restore();
			await expect(reconnecting).toHaveCount(0, { timeout: 60_000 });
			await expect.poll(() => flowCStatus(a, deviceId), { timeout: 30_000 }).not.toBeUndefined();
			await expect(card).toBeVisible({ timeout: 30_000 });
			await expect(prompt).toHaveCount(1);
			await expect(answered).toHaveCount(0);
			expect(await openAsks()).toEqual(["fixture-ask"]);
		});

		await test.step("answering on the device ends the turn on both sides", async () => {
			await prompt.locator('[data-choice="Staging"]').click();
			await prompt.locator('[data-choice="Unit tests"]').click();
			await prompt.getByRole("button", { name: "Next", exact: true }).click();
			await prompt.locator('[data-choice="Yes"]').click();
			await prompt.getByRole("button", { name: "Submit", exact: true }).click();
			await expect(prompt).toHaveCount(0);
			await expect(answered).toHaveCount(0);
			await expect.poll(() => flowCStatus(a, deviceId), { timeout: 30_000 }).toBe("ready");
			await expect
				.poll(
					async () =>
						(await readRecords(hostProfile.record)).filter(
							frame => frame.type === "extension_ui_response" && frame.id === "fixture-ask",
						).length,
				)
				.toBe(1);
			await expect
				.poll(async () => (await b.evaluate(() => window.omp.sessions.hosted())).map(s => s.status), {
					timeout: 30_000,
				})
				.toEqual(["ready"]);
			await expect(b.locator("[data-prompt-card]")).toHaveCount(0);
		});

		const [hosted] = await b.evaluate(() => window.omp.sessions.hosted());
		const sessionPath = hosted?.sessionPath ?? "";
		expect(sessionPath).not.toBe("");
		await test.step("the host's sidebar lists the hosted session once", async () => {
			await expect(b.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessionPath)}]`)).toHaveCount(
				1,
				{ timeout: 30_000 },
			);
			const paths = await b
				.locator(".omp-sidebar-session-row")
				.evaluateAll(rows => rows.map(r => r.getAttribute("data-session-path")));
			expect(paths.filter(p => p === sessionPath)).toHaveLength(1);
			expect(new Set(paths).size).toBe(paths.length);
		});

		const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
		const row = section.locator(`[data-device-session=${cssString(sessionPath)}]`);
		const exists = () =>
			fs.stat(sessionPath).then(
				() => true,
				() => false,
			);
		await test.step("the device deletes the session from its sidebar", async () => {
			await expect(row).toHaveCount(1, { timeout: 30_000 });
			expect(await exists()).toBe(true);
			await row.hover();
			await row.locator("[data-sidebar-row-menu]").click();
			await a.getByRole("menuitem", { name: "Delete session" }).click();
			const dialog = a.getByRole("dialog");
			await expect(dialog).toContainText("on Host B");
			await dialog.getByRole("button", { name: "Delete", exact: true }).click();
			await expect.poll(() => flowCStatus(a, deviceId)).toBeUndefined();
			await expect.poll(exists, { timeout: 20_000 }).toBe(false);
			await expect(row).toHaveCount(0);
		});

		await expectNoRuntimeErrors(clientProfile.desktop);
		await expectNoRuntimeErrors(hostProfile.desktop);

		await test.step("after the device relaunches the session is gone on both", async () => {
			await exitApp(clientApp);
			client = null;
			client = await launchRemote(clientProfile, { project: false, ready: false });
			const after = client.page;
			await expect(after.locator(`[data-sidebar-device="${deviceId}"]`)).toHaveAttribute(
				"data-device-state",
				"online",
				{ timeout: 60_000 },
			);
			await expect(after.locator(`[data-device-session=${cssString(sessionPath)}]`)).toHaveCount(0);
			expect(await exists()).toBe(false);
			expect(await b.evaluate(() => window.omp.sessions.hosted())).toEqual([]);
			await expect(b.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessionPath)}]`)).toHaveCount(
				0,
			);
		});

		await expectNoRuntimeErrors(clientProfile.desktop);
		await expectNoRuntimeErrors(hostProfile.desktop);
	} finally {
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await proxy.close();
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

// ── Flow (d) ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Daily flow (d): the phone's page across a notification, a steer and a reload, on the built app behind the fake
 * `tailscale serve` (e2e/fixture/phone-serve.ts), in Chromium (Pixel 7).
 *
 * Two tabs → a turn finishes in the tab the phone is not showing → the service worker's click message
 * (`notification-click`, src/renderer/web/notify.ts) brings that tab forward → a turn runs there and a steer sent
 * from the phone composer reaches the fake omp once and shows once → an unsent draft → a reload keeps the draft,
 * the tab and the transcript, without loading the page again on its own.
 */
async function dFrames(file: string): Promise<Array<{ type: string; message?: unknown; streamingBehavior?: unknown }>> {
	const text = await fs.readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line): unknown => JSON.parse(line))
		.filter(
			(frame): frame is { type: string; message?: unknown; streamingBehavior?: unknown } =>
				typeof frame === "object" && frame !== null && "type" in frame && typeof frame.type === "string",
		);
}

const dSent = (f: { type: string; message?: unknown }) =>
	["prompt", "steer", "follow_up"].includes(f.type) && f.message === "steer from the phone";

const dActiveTab = (phone: Page) =>
	phone.evaluate(async () => (await window.omp.tabs.list()).find(tab => tab.active)?.tabId ?? null);

/** What the service worker does on a notification click: post `notification-click` to the page it focused. */
const dClick = (phone: Page, tabId: string) =>
	phone.evaluate(id => {
		navigator.serviceWorker.dispatchEvent(
			new MessageEvent("message", { data: { type: "notification-click", payload: { tabId: id } } }),
		);
	}, tabId);

const dBash = (phone: Page, tabId: string, command: string) =>
	phone.evaluate(([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }), [
		tabId,
		command,
	] as const);

test("daily flow d: a notification click opens its tab on the phone, a steer arrives once, and a reload keeps the draft", async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-daily-d-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const record = path.join(root, "commands.jsonl");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const tailscale = await fixtureTailscale(root, { backendState: "Running" });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
		OMP_GUI_TEST_RECORD: record,
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const browser = await chromium.launch();
	let app: ElectronApplication | null = null;
	let proxy: ServeProxy | null = null;
	try {
		app = await electron.launch({
			args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
			env,
		});
		const desk = await app.firstWindow();
		await desk.waitForFunction(() => window.omp?.rpc != null);
		await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"), {
				timeout: 60_000,
			})
			.toBe("ready");
		const [site] = serveSites(tailscale);
		if (!site) throw new Error("no serve handler published");
		proxy = await ServeProxy.start(site, "seuput@example.com");
		const phone = await (await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" })).newPage();
		let loads = 0;
		phone.on("domcontentloaded", () => {
			loads++;
		});

		let tabA = "";
		let tabB = "";
		await test.step("the phone pairs and has two tabs", async () => {
			await phone.goto(`${proxy?.url}/`);
			await expect(phone.getByRole("button", { name: "Open menu" })).toBeVisible({ timeout: 60_000 });
			const spawned = await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
			tabA = spawned?.tabId ?? "";
			expect(tabA).not.toBe("");
			await phone.reload();
			await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
			// The spawned tab, active and ready (the page's untouched first tab gives way to it).
			await expect
				.poll(
					() =>
						phone.evaluate(
							async id => (await window.omp.tabs.list()).find(t => t.tabId === id && t.active)?.status,
							tabA,
						),
					{ timeout: 60_000 },
				)
				.toBe("ready");
			// A turn that keeps running while the phone switches to another tab.
			const started = await phone.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
				tabA,
			);
			expect(started.success, JSON.stringify(started)).toBe(true);
			// A second session from the phone's own drawer: the page moves onto it.
			await phone.getByRole("button", { name: "Open menu" }).click();
			// A code session starts from its project row's + (the sidebar has no New session button).
			await phone.locator("[data-drawer] [data-sidebar-group-new]").first().click();
			await expect
				.poll(() => phone.evaluate(async () => (await window.omp.tabs.list()).length), { timeout: 30_000 })
				.toBe(2);
			await expect(phone.locator("[data-drawer]")).toHaveCount(0, { timeout: 30_000 });
			tabB =
				(await phone.evaluate(async () => (await window.omp.tabs.list()).map(tab => tab.tabId))).find(
					id => id !== tabA,
				) ?? "";
			expect(tabB).not.toBe("");
			await expect.poll(() => dActiveTab(phone), { timeout: 30_000 }).toBe(tabB);
			// The person types into it, so leaving it for the other tab does not close the empty one.
			const typed = await dBash(phone, tabB, "fixture:title:Second phone tab");
			expect(typed.success, JSON.stringify(typed)).toBe(true);
			await expect
				.poll(() =>
					phone.evaluate(async id => (await window.omp.tabs.list()).find(t => t.tabId === id)?.status, tabB),
				)
				.toBe("ready");
			await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 30_000 });
			await expect(phone.getByText("Background run finished")).toHaveCount(0);
		});

		await test.step("a turn finishes in the tab the phone is not showing", async () => {
			expect(await dBash(phone, tabA, "fixture:finish")).toMatchObject({ success: true });
			// Still on B: A's reply is not on screen.
			expect(await dActiveTab(phone)).toBe(tabB);
			await expect(phone.getByText("Background run finished")).toHaveCount(0);
		});

		await test.step("the service worker's notification click shows that tab with its reply", async () => {
			await dClick(phone, tabA);
			await expect.poll(() => dActiveTab(phone), { timeout: 30_000 }).toBe(tabA);
			await expect(phone.getByText("Background run finished")).toHaveCount(1, { timeout: 30_000 });
			await expect(phone.locator("[data-drawer]")).toHaveCount(0);
		});

		const field = phone.locator("[data-composer-input]").first();
		// The transcript's message rows; the working card's own steer note (`[data-steer]`) is another element.
		const steerRows = phone.locator(".markdown-body p").filter({ hasText: /^steer from the phone$/ });
		const send = phone.getByRole("button", { name: /^(Send|보내기)$/ });
		await test.step("a turn runs on that tab and a steer sent from the phone arrives once", async () => {
			await field.fill("fixture steer work");
			await expect(send).toBeEnabled();
			await send.click();
			await expect(phone.getByRole("button", { name: /^(Stop|중지)$/ })).toBeVisible({ timeout: 30_000 });
			await expect(phone.locator("[data-send-mode]")).toHaveAttribute("data-send-mode", "steer", {
				timeout: 30_000,
			});
			await field.fill("steer from the phone");
			await expect(send).toBeEnabled({ timeout: 30_000 });
			await send.click();
			await expect(field).toHaveValue("");
			await expect
				.poll(async () => (await dFrames(record)).filter(dSent).length, {
					timeout: 30_000,
				})
				.toBe(1);
			// Nothing else goes by the steer's echo: until the loop takes it the steer waits in the queue (or shows as
			// its echo), never twice, and the record holds one frame.
			await phone.waitForTimeout(1500);
			expect(await steerRows.count()).toBeLessThanOrEqual(1);
			// A web page's composer leaves the choice to the host: stock's steer is a prompt with `streamingBehavior: "steer"`.
			expect((await dFrames(record)).filter(dSent)).toMatchObject([{ type: "prompt", streamingBehavior: "steer" }]);
			// The running loop takes the steer in as its own user message: it stays on the page (its row, or the work
			// card's steer note once the card folds it) and the record still holds the one frame.
			expect(await dBash(phone, tabA, "fixture:steer-next")).toMatchObject({ success: true });
			await expect
				.poll(() => phone.getByText("steer from the phone", { exact: true }).count(), { timeout: 30_000 })
				.toBeGreaterThan(0);
			expect((await dFrames(record)).filter(dSent)).toHaveLength(1);
			expect(await dBash(phone, tabA, "fixture:steer-finish")).toMatchObject({ success: true });
			await expect(phone.getByRole("button", { name: /^(Stop|중지)$/ })).toHaveCount(0, { timeout: 30_000 });
		});

		await test.step("a reload keeps the draft, the tab and the transcript, and the page does not load again by itself", async () => {
			await field.fill("a draft not sent yet");
			// Saved once typing pauses (InputArea's DRAFT_SAVE_MS).
			await phone.waitForTimeout(1500);
			const before = loads;
			await phone.reload();
			await expect(field).toBeVisible({ timeout: 60_000 });
			await expect(field).toHaveValue("a draft not sent yet", { timeout: 30_000 });
			expect(await dActiveTab(phone)).toBe(tabA);
			// The finished turn folds the steer into its work card's note; it is on screen once, nothing else repeats it.
			await expect(phone.getByText("steer from the phone", { exact: true })).toHaveCount(1, { timeout: 30_000 });
			await expect(phone.locator("[data-steer]").filter({ hasText: "steer from the phone" })).toHaveCount(1);
			await expect(phone.getByText("Background run finished")).toHaveCount(1);
			await expect(phone.locator(".omp-skeleton, .boot-shell")).toHaveCount(0, { timeout: 30_000 });
			expect(await phone.evaluate(async () => (await window.omp.tabs.list()).length)).toBe(2);
			// The reload is the one load; nothing reloads the page afterwards.
			const afterReload = loads;
			expect(afterReload).toBe(before + 1);
			await phone.waitForTimeout(5000);
			expect(loads).toBe(afterReload);
			await expect(field).toHaveValue("a draft not sent yet");
		});

		await expectNoRuntimeErrors(desktop);
	} finally {
		await browser.close();
		await proxy?.close();
		if (app) await exitApp(app).catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
	}
});

// ── Flow (e) ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Daily flow E: delete sessions out of a 3-pane split, then relaunch. Three saved sessions share the window;
 * deleting the unfocused one, then the focused one, leaves the split sane and nothing comes back after a restart.
 */
const FLOW_E_NAMES = ["Alpha", "Beta", "Gamma"] as const;

interface FlowELaunched {
	app: ElectronApplication;
	page: Page;
	errors: string[];
}

async function flowELaunch(root: string, restore: boolean): Promise<FlowELaunched> {
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([
		fs.mkdir(project, { recursive: true }),
		fs.mkdir(desktop, { recursive: true }),
		fs.mkdir(agent, { recursive: true }),
	]);
	await fs
		.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true }),
			{
				flag: "wx",
			},
		)
		.catch(() => undefined);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			...(restore ? [] : [project]),
			`--user-data-dir=${desktop}`,
		],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, errors };
}

const flowETabs = (page: Page) => page.evaluate(() => window.omp.tabs.list());
const flowERow = (page: Page, title: string) => page.locator(".omp-sidebar-session-row", { hasText: title });
const flowEPick = (page: Page, title: string) => flowERow(page, title).locator("button[data-roving-item]").click();

async function flowEActive(page: Page) {
	const active = (await flowETabs(page)).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active;
}

async function flowEMakeSession(page: Page, tabId: string, title: string): Promise<void> {
	await page.evaluate(([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }), [
		tabId,
		`Work on ${title}`,
	] as const);
	await expect
		.poll(async () => {
			const tab = (await flowETabs(page)).find(entry => entry.tabId === tabId);
			return tab?.status === "ready" ? (tab.sessionPath ?? "") : "";
		})
		.toMatch(/\.jsonl$/);
	await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
		tabId,
		`fixture:title:${title}`,
	] as const);
	await expect(flowERow(page, title)).toBeVisible();
}

async function flowEOpenSession(page: Page, title: string): Promise<void> {
	const before = (await flowETabs(page)).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await flowETabs(page)).length).toBe(before.length + 1);
	const created = (await flowETabs(page)).find(tab => !before.includes(tab.tabId));
	if (!created) throw new Error("No new tab");
	await expect
		.poll(async () => (await flowETabs(page)).find(tab => tab.tabId === created.tabId)?.status)
		.toBe("ready");
	await expect.poll(async () => (await flowEActive(page)).tabId).toBe(created.tabId);
	await flowEMakeSession(page, created.tabId, title);
}

async function flowEDragOnto(page: Page, title: string, target: Locator, fx: number, fy: number, placement: string) {
	const rowBox = await flowERow(page, title).boundingBox();
	const pane = await target.boundingBox();
	if (!rowBox || !pane) throw new Error("expected drag boxes");
	await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(rowBox.x + rowBox.width / 2 + 20, rowBox.y + rowBox.height / 2, { steps: 4 });
	await page.mouse.move(pane.x + pane.width * fx + 2, pane.y + pane.height * fy, { steps: 12 });
	await page.mouse.move(pane.x + pane.width * fx, pane.y + pane.height * fy, { steps: 2 });
	await expect(page.locator("[data-split-ghost]")).toHaveAttribute("data-split-ghost", placement);
	await page.mouse.up();
}

/** Pane titles by session name, through the tab's session file matched to a sidebar row. */
async function flowEPaneNames(page: Page): Promise<string[]> {
	const rows = await page.locator(".omp-sidebar-session-row").evaluateAll(elements =>
		elements.map(element => ({
			path: element.getAttribute("data-session-path") ?? "",
			text: element.textContent ?? "",
		})),
	);
	const tabs = await flowETabs(page);
	const ids = await page
		.locator(".omp-session-pane")
		.evaluateAll(els => els.map(el => (el as HTMLElement).dataset.tabId ?? ""));
	return ids
		.map(id => {
			const tab = tabs.find(entry => entry.tabId === id);
			return (
				FLOW_E_NAMES.find(name => rows.some(row => row.path === tab?.sessionPath && row.text.includes(name))) ??
				`?${id}`
			);
		})
		.sort();
}

async function flowEDelete(page: Page, title: string): Promise<void> {
	const row = flowERow(page, title);
	await expect(row).toBeVisible();
	// A row stays live-only (no Delete) until the session index lists its file.
	const remove = page.getByRole("menuitem", { name: "Delete", exact: true });
	await expect(async () => {
		await page.keyboard.press("Escape");
		await row.click({ button: "right" });
		await expect(remove).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 20_000 });
	await remove.click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(row).toHaveCount(0);
}

test("daily flow e: deleting sessions out of a 3-pane split keeps the split sane, across a relaunch", async () => {
	test.setTimeout(300_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-daily-e-")));
	const desktop = path.join(root, "desktop");
	let launched = await flowELaunch(root, false);
	try {
		let page = launched.page;
		const paneCount = () => page.locator(".omp-session-pane");
		const rowTitles = () => page.locator(".omp-sidebar-session-row").allTextContents();
		const sessionRowCount = async () => (await rowTitles()).length;

		await test.step("three saved sessions", async () => {
			await flowEMakeSession(page, (await flowEActive(page)).tabId, "Alpha");
			await flowEOpenSession(page, "Beta");
			await flowEOpenSession(page, "Gamma");
			await expect.poll(sessionRowCount).toBe(3);
		});

		await test.step("build a 3-pane split", async () => {
			// Gamma is active: Gamma | Alpha, then Beta under Gamma.
			await flowEDragOnto(page, "Alpha", page.locator(".omp-split-workspace"), 0.92, 0.5, "right");
			await expect(paneCount()).toHaveCount(2);
			await flowEDragOnto(page, "Beta", page.locator("[data-split]").first(), 0.5, 0.92, "bottom");
			await expect(paneCount()).toHaveCount(3);
			expect(await flowEPaneNames(page)).toEqual(["Alpha", "Beta", "Gamma"]);
		});

		await test.step("composer drafts in every pane", async () => {
			const names = new Map<string, string>();
			const tabs = await flowETabs(page);
			const rows = await page
				.locator(".omp-sidebar-session-row")
				.evaluateAll(els =>
					els.map(el => ({ path: el.getAttribute("data-session-path") ?? "", text: el.textContent ?? "" })),
				);
			for (const tab of tabs) {
				const name = FLOW_E_NAMES.find(n => rows.some(r => r.path === tab.sessionPath && r.text.includes(n)));
				if (name) names.set(name, tab.tabId);
			}
			for (const name of FLOW_E_NAMES) {
				const field = page.locator(`.omp-session-pane[data-tab-id="${names.get(name)}"] .omp-composer-input`);
				await field.fill(`draft ${name}`);
			}
		});

		const drafts = async () =>
			(
				await page
					.locator(".omp-session-pane .omp-composer-input")
					.evaluateAll(els => els.map(el => (el as HTMLTextAreaElement).value ?? el.textContent ?? ""))
			).sort();

		await test.step("delete the unfocused middle session (Gamma)", async () => {
			await flowEPick(page, "Beta");
			await expect(paneCount()).toHaveCount(3);
			await flowEDelete(page, "Gamma");
			await expect(paneCount()).toHaveCount(2);
			expect(await flowEPaneNames(page)).toEqual(["Alpha", "Beta"]);
			expect((await rowTitles()).filter(text => text.includes("Gamma"))).toHaveLength(0);
			expect(await sessionRowCount()).toBe(2);
			expect(await drafts()).toEqual(["draft Alpha", "draft Beta"]);
			const boxes = await page
				.locator(".omp-session-pane")
				.evaluateAll(els => els.map(el => el.getBoundingClientRect()).map(b => [b.width, b.height]));
			for (const [w, h] of boxes) {
				expect(w).toBeGreaterThan(200);
				expect(h).toBeGreaterThan(200);
			}
			const tabs = await flowETabs(page);
			expect(tabs).toHaveLength(2);
			expect(tabs.filter(tab => tab.active)).toHaveLength(1);
		});

		await test.step("relaunch keeps the 2-pane split and no Gamma", async () => {
			await exitApp(launched.app);
			await expectNoRuntimeErrors(desktop);
			launched = await flowELaunch(root, true);
			page = launched.page;
			await expect.poll(sessionRowCount).toBe(2);
			expect((await rowTitles()).join("\n")).not.toContain("Gamma");
			expect((await rowTitles()).join("\n")).not.toContain("New session");
			const tabs = await flowETabs(page);
			expect(tabs.map(tab => tab.sessionPath).filter(Boolean)).toHaveLength(tabs.length);
			expect(tabs.length).toBeLessThanOrEqual(2);
			await flowEPick(page, "Alpha");
			await expect(paneCount()).toHaveCount(2);
			expect(await flowEPaneNames(page)).toEqual(["Alpha", "Beta"]);
		});

		await test.step("delete the focused pane's session (Alpha)", async () => {
			await expect.poll(async () => (await flowEActive(page)).sessionPath).toMatch(/\.jsonl$/);
			await flowEDelete(page, "Alpha");
			await expect(paneCount()).toHaveCount(1);
			expect(await flowEPaneNames(page)).toEqual(["Beta"]);
			expect(await sessionRowCount()).toBe(1);
			await expect.poll(async () => (await flowETabs(page)).filter(tab => tab.active).length).toBe(1);
			await expect(page.locator(".omp-session-pane .omp-composer-input")).toHaveCount(1);
			const box = await page.locator(".omp-session-pane").boundingBox();
			expect(box?.width).toBeGreaterThan(400);
		});

		await test.step("relaunch keeps only Beta, no ghosts", async () => {
			await exitApp(launched.app);
			await expectNoRuntimeErrors(desktop);
			launched = await flowELaunch(root, true);
			page = launched.page;
			await expect.poll(sessionRowCount).toBe(1);
			const text = (await rowTitles()).join("\n");
			expect(text).toContain("Beta");
			expect(text).not.toContain("Alpha");
			expect(text).not.toContain("Gamma");
			expect(text).not.toContain("New session");
			const tabs = await flowETabs(page);
			expect(tabs.length).toBeLessThanOrEqual(1);
			await expect(paneCount()).toHaveCount(1);
			const files = (await fs.readdir(path.join(root, "agent", "sessions"), { recursive: true })).filter(name =>
				name.endsWith(".jsonl"),
			);
			expect(files).toHaveLength(1);
			expect(launched.errors).toEqual([]);
		});
	} finally {
		await exitApp(launched.app);
		await expectNoRuntimeErrors(desktop);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

// ── Flow (f) ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Daily flow F: one session with a prompt → Settings (theme, language, persisted in prefs) → the composer model
 * picker → the diagnostics preview and the saved bundles (no planted secret in any member) → Autopilot started
 * from the Mode popover and ended with Stop → relaunch keeps the theme and the language.
 */
const FLOW_F_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
const FLOW_F_HOME = "/Users/janedoe/secret-project";
/** A translation key shown instead of its text: `settings.gui.language`, `about.diagnosticsShow`. */
const FLOW_F_RAW_KEY =
	/\b(?:settings|input|about|sidebar|common|diagnosticBundle|autopilot|chat|dock)\.[a-z]\w*(?:\.\w+)*/;

const flowFSettings = (page: Page) => page.locator("[data-settings-page]");

async function flowFOpenSettings(page: Page, section: string) {
	const settings = flowFSettings(page);
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator(`[data-settings-section="${section}"]`).click();
	return settings;
}

async function flowFCloseSettings(page: Page) {
	await page.keyboard.press("Escape");
	await expect(flowFSettings(page)).toBeHidden();
}

const flowFThemeName = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-theme-name"));

async function flowFRawKeys(page: Page) {
	expect(await page.locator("body").innerText()).not.toMatch(FLOW_F_RAW_KEY);
}

async function flowFModelId(page: Page, tabId: string) {
	const { data } = await command(page, tabId, { type: "get_state" });
	if (data === null || typeof data !== "object" || !("model" in data)) return undefined;
	const model = data.model;
	return model !== null && typeof model === "object" && "id" in model ? model.id : undefined;
}

async function flowFMembers(file: string) {
	const zip = await JSZip.loadAsync(await fs.readFile(file));
	const out: Record<string, string> = {};
	for (const name of Object.keys(zip.files)) out[name] = (await zip.files[name]?.async("string")) ?? "";
	return out;
}

test("daily flow f: settings, model, diagnostics bundle and autopilot chain without leaks, theme and language persist", async () => {
	test.setTimeout(300_000);
	const profile = await makeApProfile({
		script: { cycleMs: 600 },
		env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1" },
	});
	let { app, page } = await launchAp(profile);
	try {
		const tabId = await mainTab(page);

		await test.step("a prompt carrying a token and a home path gets its reply", async () => {
			const input = page.locator(".omp-composer-input").first();
			await input.fill(`hello there ${FLOW_F_TOKEN} in ${FLOW_F_HOME}`);
			await input.press("Enter");
			await expect(page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		});

		await test.step("Appearance: nord, then back to System", async () => {
			const settings = await flowFOpenSettings(page, "appearance");
			await settings.locator('[data-theme-option="nord"]').click();
			await expect.poll(() => flowFThemeName(page)).toBe("nord");
			await settings.locator('[data-theme-option="system"]').click();
			await expect.poll(() => flowFThemeName(page)).not.toBe("nord");
			await expect.poll(() => page.evaluate(() => window.omp.prefs.get("themeName"))).toBe("system");
			await flowFCloseSettings(page);
			expect(await flowFThemeName(page)).not.toBe("nord");
		});

		await test.step("General: Korean labels, no raw key, and back to English", async () => {
			let settings = await flowFOpenSettings(page, "general");
			await settings.locator("#setting-gui-language select").selectOption("ko");
			await expect(settings.locator('[data-settings-section="general"]')).toContainText("일반");
			await expect(settings.locator('[data-settings-section="appearance"]')).toContainText("화면 및 입력");
			await expect(settings.locator('[data-settings-section="updates"]')).toContainText("업데이트 및 정보");
			await expect(settings.locator("#setting-gui-language")).toContainText("언어");
			await flowFRawKeys(page);
			await expect.poll(() => page.evaluate(() => window.omp.prefs.get("language"))).toBe("ko");
			await flowFCloseSettings(page);
			await expect(page.locator("[data-run-settings-trigger]")).toContainText("실행 설정");
			await flowFRawKeys(page);

			settings = await flowFOpenSettings(page, "general");
			await settings.locator("#setting-gui-language select").selectOption("en");
			await expect(settings.locator('[data-settings-section="general"]')).toContainText("General");
			await expect(settings.locator("#setting-gui-language")).toContainText("Language");
			await flowFRawKeys(page);
			await expect.poll(() => page.evaluate(() => window.omp.prefs.get("language"))).toBe("en");
			await flowFCloseSettings(page);
			await expect(page.locator("[data-run-settings-trigger]")).toContainText("Run settings");
		});

		await test.step("the composer model picker changes the model: chip and get_state follow", async () => {
			await page.locator("[data-model-chip]").click();
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("option", { name: /Sonnet 4\.5/ }).click();
			await expect(dialog).toBeHidden();
			// Beside the provider's mark the chip drops the brand word the mark draws (`chipModelName`).
			await expect(page.locator("[data-model-chip]")).toContainText("Sonnet 4.5");
			await expect(page.locator("[data-model-chip]")).toHaveAttribute("aria-label", /Claude Sonnet 4\.5/);
			await expect.poll(() => flowFModelId(page, tabId)).toBe("claude-sonnet-4-5");
		});

		await test.step("diagnostics preview and bundles hold no planted secret", async () => {
			const settings = await flowFOpenSettings(page, "updates");
			const row = settings.locator("#setting-about-diagnostics");
			await row.scrollIntoViewIfNeeded();
			await row.locator("[data-diagnostics-toggle]").click();
			const preview = row.locator("[data-diagnostics-text]");
			await expect(preview).toBeVisible();
			await expect(preview).toContainText("OMPdesk");
			const previewText = (await preview.textContent()) ?? "";
			expect(previewText).not.toContain(FLOW_F_TOKEN);
			expect(previewText).not.toContain("/Users/janedoe");

			const save = async (target: string, item: string) => {
				await app.evaluate(({ dialog }, file) => {
					dialog.showSaveDialog = (async () => ({
						canceled: false,
						filePath: file,
					})) as typeof dialog.showSaveDialog;
				}, target);
				await row.getByRole("button", { name: "Save diagnostic bundle", exact: true }).click();
				await page.getByRole("menuitem", { name: item, exact: true }).click();
				await expect
					.poll(
						() =>
							fs.access(target).then(
								() => true,
								() => false,
							),
						{ timeout: 30_000 },
					)
					.toBe(true);
			};
			const full = path.join(profile.root, "flow-f-full.zip");
			await save(full, "Save diagnostic bundle");
			const fullMembers = await flowFMembers(full);
			expect(Object.keys(fullMembers)).toContain("ompdesk-diagnostics.txt");
			expect(fullMembers["session.md"]).toContain("hello there");
			const anon = path.join(profile.root, "flow-f-anon.zip");
			await save(anon, "Save diagnostic bundle (anonymized)");
			const anonMembers = await flowFMembers(anon);
			expect(Object.keys(anonMembers)).toContain("ompdesk-diagnostics.txt");
			for (const [name, text] of [...Object.entries(fullMembers), ...Object.entries(anonMembers)]) {
				expect(text, `${name} token`).not.toContain(FLOW_F_TOKEN);
				expect(text, `${name} home`).not.toContain("/Users/janedoe");
			}
			await flowFCloseSettings(page);
		});

		await test.step("Autopilot starts from the Mode popover and ends with Stop", async () => {
			const run = await startFromSheet(page, "en");
			// No panel opens: the composer's "show the run" brings the run's section of the work board into view.
			await expect(page.locator("[data-autopilot-chip-open]")).toBeVisible();
			await page.locator("[data-autopilot-chip-open]").click();
			const runSection = page.locator('[data-board-section="autopilot"]').first();
			await expect(runSection).toBeVisible();
			await expect(page.locator("[data-autopilot-state]").first()).toHaveAttribute(
				"data-autopilot-state",
				"running",
			);
			await expect(page.locator("[data-run-settings-trigger]")).toContainText(/Cycle \d/);
			await waitForStatus(page, run.tabId, s => s.state === "running", "the run is running");
			expect((await activeTools(page, run.tabId)).includes("autopilot")).toBe(true);

			await runSection.locator("[data-autopilot-ship-stop]").click();
			await expect(page.locator("[data-autopilot-state]").first()).toHaveAttribute("data-autopilot-state", "ended", {
				timeout: 90_000,
			});
			await expect(page.locator("[data-autopilot-reason]").first()).toHaveAttribute("data-autopilot-reason", "user");
			await expect(page.locator("[data-autopilot-chip-open]")).toHaveCount(0);
			await expect(page.locator("[data-autopilot-dock]")).toHaveCount(0);
			await expect(page.locator("[data-run-settings-trigger]")).not.toContainText(/Cycle \d/);

			const session = await recorded(profile, "fixture_autopilot_session");
			expect(session.map(entry => entry.action)).toEqual(expect.arrayContaining(["arm", "disarm"]));
			const tools = await activeTools(page, run.tabId);
			expect(tools).not.toContain("autopilot");
			for (const name of ["ask", "eval", "debug"]) expect(tools, name).toContain(name);
		});

		await test.step("nord and Korean are picked for the relaunch", async () => {
			let settings = await flowFOpenSettings(page, "appearance");
			await settings.locator('[data-theme-option="nord"]').click();
			await expect.poll(() => flowFThemeName(page)).toBe("nord");
			settings = await flowFOpenSettings(page, "general");
			await settings.locator("#setting-gui-language select").selectOption("ko");
			await expect(settings.locator("#setting-gui-language")).toContainText("언어");
			await flowFCloseSettings(page);
		});

		await exitApp(app);
		await expectNoRuntimeErrors(profile.desktop);

		await test.step("after a relaunch the theme and the language stand", async () => {
			({ app, page } = await launchAp(profile));
			await expect.poll(() => flowFThemeName(page)).toBe("nord");
			await expect(page.locator("[data-run-settings-trigger]").first()).toContainText("실행 설정");
			const settings = await flowFOpenSettings(page, "general");
			await expect(settings.locator('[data-settings-section="general"]')).toContainText("일반");
			await flowFRawKeys(page);
			await flowFCloseSettings(page);
			await expect(page.locator("[data-autopilot-chip-open]")).toHaveCount(0);
		});
		await exitApp(app);
		await expectNoRuntimeErrors(profile.desktop);
	} finally {
		await exitApp(app).catch(() => {});
		await cleanupAp(profile);
	}
});
