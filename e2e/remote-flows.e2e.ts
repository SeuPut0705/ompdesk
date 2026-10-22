/**
 * Work on a paired host's tab, end to end, on two instances with the fake omp
 * (remote-harness.ts): A (the client, in each language and theme) opens a tab on
 * B and every panel of that tab acts on B's machine, never on A's:
 * - the Terminal runs B's shell in B's folder, and "Run in terminal" types into it;
 * - Files lists, edits, saves, keeps file tabs and searches B's project;
 * - Changes commits, pushes and shows the history of B's repository;
 * - the agent's media plays (over the link, capped) and its file cards open B's files;
 * - the context inspector reads B's omp.
 * Captures in the test output directory.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { tinyPptx, tinyXlsx } from "./file-viewer-fixtures";
import { capture, cssString, exitApp, openDestination, variants } from "./harness";
import {
	connectHost,
	type Language,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
	type Theme,
} from "./remote-harness";

test.describe.configure({ mode: "parallel" });

function translate(language: Language, key: string, vars: Record<string, string | number> = {}): string {
	const template = (language === "ko" ? ko : en)[key];
	if (template === undefined) throw new Error(`no ${language} string ${key}`);
	return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** B's project: a repository with a pushed first commit, two changed files and an origin. */
async function seedHostProject(root: string, project: string): Promise<string> {
	const remote = path.join(root, "remote.git");
	git(root, "init", "-q", "--bare", "remote.git");
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "host@example.com");
	git(project, "config", "user.name", "Host");
	git(project, "config", "commit.gpgsign", "false");
	await fs.mkdir(path.join(project, "src"));
	await fs.writeFile(path.join(project, "notes.md"), "# Notes\n");
	await fs.writeFile(path.join(project, "src", "app.ts"), "export const one = 1;\n");
	git(project, "add", ".");
	git(project, "commit", "-qm", "feat: seed the host project");
	git(project, "remote", "add", "origin", remote);
	git(project, "push", "-q", "-u", "origin", "main");
	return remote;
}

/** The docked side panel on one of its views. */
async function panelView(page: Page, language: Language, view: "terminal" | "files" | "diff") {
	const aside = page.locator("aside[data-docked]");
	if (!(await aside.isVisible()))
		await page.getByRole("button", { name: translate(language, "titlebar.sidePanel"), exact: true }).click();
	await aside.getByRole("button", { name: translate(language, `panel.tabs.${view}`), exact: true }).click();
	return aside;
}

async function exists(file: string): Promise<boolean> {
	return fs.stat(file).then(
		() => true,
		() => false,
	);
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`a host's tab works on the host: terminal, files, changes, media, context (${language} ${theme})`, async () => {
			test.setTimeout(240_000);
			const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
			const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-flows-")));
			let host: RemoteInstance | null = null;
			let client: RemoteInstance | null = null;
			try {
				const hostProfile = await makeRemoteProfile(parent, "b", {
					language: "en",
					theme: "dark",
					// Only B's omp reports a context over its window: the inspector shows whose omp it read.
					env: { OMP_GUI_TEST_CONTEXT_OVER: "1" },
				});
				const clientProfile = await makeRemoteProfile(parent, "a", {
					language,
					theme,
					port: hostProfile.port,
				});
				const origin = await seedHostProject(path.dirname(hostProfile.project), hostProfile.project);
				host = await launchRemote(hostProfile);
				client = await launchRemote(clientProfile);
				const a = client.page;
				const deviceId = await connectHost(host.page, a, "Host B");
				const remoteTab = await openHostFolder(a, deviceId, hostProfile.project);
				const hostFile = (rel: string) => path.join(hostProfile.project, rel);
				const clientFile = (rel: string) => path.join(clientProfile.project, rel);

				await test.step("terminal and Run in terminal", async () => {
					if (process.platform === "win32") return;
					const aside = await panelView(a, language, "terminal");
					const viewport = aside.locator("[data-terminal-viewport]");
					await viewport.click();
					await a.keyboard.type("echo where=$PWD\n");
					await expect(viewport).toContainText(`where=${hostProfile.project}`, { timeout: 20_000 });
					// A fence in the agent's reply runs in that same shell on B.
					const input = a.locator("textarea").first();
					await input.fill("fixture reply actions");
					await input.press("Enter");
					const block = a.locator(".omp-code-block").last();
					await expect(block).toContainText("echo ompdesk-run-in-terminal", { timeout: 30_000 });
					await block.hover();
					await block.getByRole("button", { name: t("codeblock.runInTerminal") }).click();
					// The panel is narrow: xterm wraps the command, so the rows are read joined.
					await expect
						.poll(async () => (await aside.locator(".xterm-rows").innerText()).replaceAll("\n", ""), {
							timeout: 20_000,
						})
						.toMatch(/echo ompdesk-run-in-terminal\s*ompdesk-run-in-terminal/);
					await capture(a, `${language}-${theme}-terminal`);
				});

				await test.step("files: edit, save, file tabs, content search", async () => {
					const aside = await panelView(a, language, "files");
					const row = (id: string) => aside.locator(`[data-tree-id="${id}"]`);
					await row("file:notes.md").click();
					await aside.getByRole("button", { name: t("fileViewer.edit"), exact: true }).click();
					const editor = aside.getByRole("textbox", { name: t("fileViewer.editorLabel", { name: "notes.md" }) });
					await expect(editor).toBeFocused();
					await a.keyboard.press("ControlOrMeta+End");
					await a.keyboard.type("Edited from A\n");
					const status = aside.locator("[data-editor-status]");
					await expect(status).toHaveText(t("common.unsaved"));
					await a.keyboard.press("ControlOrMeta+s");
					await expect(status).toHaveText(t("common.saved"));
					expect(await fs.readFile(hostFile("notes.md"), "utf8")).toBe("# Notes\nEdited from A\n");
					expect(await exists(clientFile("notes.md"))).toBe(false);
					await capture(a, `${language}-${theme}-files-edit`);

					// A second file opens beside it: two file tabs, each read from B.
					await aside.getByRole("button", { name: t("filesPanel.back"), exact: true }).click();
					await row("dir:src").click();
					await row("file:src/app.ts").click();
					const tabs = aside.locator("[data-file-tabs] [data-file-tab]");
					await expect(tabs).toHaveCount(2);
					await expect(aside.locator("[data-file-preview-title]")).toContainText("app.ts");
					await expect(aside.getByText("export const one = 1;")).toBeVisible();
					await capture(a, `${language}-${theme}-files-tabs`);
					await tabs.first().click();
					await expect(aside.getByText("Edited from A")).toBeVisible();

					// Content search runs stock grep on B.
					await a.keyboard.press("Alt+ControlOrMeta+f");
					const query = aside.getByRole("searchbox", { name: t("filesPanel.contentSearch.query") });
					await expect(query).toBeFocused();
					await query.fill("export const one");
					await expect(aside.locator('[data-content-search-file="src/app.ts"]')).toBeVisible({ timeout: 15_000 });
					await capture(a, `${language}-${theme}-files-search`);
					await aside.getByRole("button", { name: /export const one/ }).click();
					await expect(aside.locator("[data-viewer-kind]")).toBeVisible();
					await aside.getByRole("button", { name: t("filesPanel.back"), exact: true }).click();
					await aside.getByRole("button", { name: t("filesPanel.contentSearch.toggle"), exact: true }).click();
				});

				await test.step("changes: commit, push, history", async () => {
					const aside = await panelView(a, language, "diff");
					await expect(aside.locator("[data-scm-bar]")).toBeVisible({ timeout: 20_000 });
					await aside.getByRole("checkbox", { name: t("scm.stageFile", { path: "notes.md" }) }).click();
					await aside.getByRole("textbox", { name: t("scm.commit.messageLabel") }).fill("docs: edited from A");
					await aside.getByRole("button", { name: t("scm.commit.submit", { count: 1, branch: "main" }) }).click();
					await expect
						.poll(() => git(hostProfile.project, "log", "-1", "--format=%s"))
						.toBe("docs: edited from A");
					const push = aside
						.locator("[data-scm-bar]")
						.getByRole("button", { name: new RegExp(`^${t("scm.remote.push")}`) });
					await expect(push).toHaveText(`${t("scm.remote.push")}1`);
					await capture(a, `${language}-${theme}-changes`);
					await push.click();
					await expect(push).toHaveText(t("scm.remote.push"));
					expect(git(path.dirname(origin), "--git-dir", origin, "log", "-1", "--format=%s", "main")).toBe(
						"docs: edited from A",
					);
					await aside.getByRole("combobox", { name: t("diffPanel.title") }).selectOption("commits");
					const history = aside.locator("[data-commit-history]");
					await history.getByRole("button", { name: /docs: edited from A/ }).click();
					await history.getByRole("button", { name: /notes\.md/ }).click();
					await expect(history).toContainText("Edited from A");
					await capture(a, `${language}-${theme}-history`);
					await aside.getByRole("combobox", { name: t("diffPanel.title") }).selectOption("repository");
				});

				await test.step("media plays over the link, capped; file cards read the host", async () => {
					await a.getByRole("button", { name: t("titlebar.sidePanel"), exact: true }).click();
					await expect(a.locator("aside[data-docked]")).toHaveCount(0);
					const input = a.locator("textarea").first();
					await input.fill("fixture media");
					await input.press("Enter");
					const reply = a.locator(".omp-chat-media-list").last();
					await expect(reply).toBeVisible({ timeout: 30_000 });
					const player = (name: string) => reply.locator(".omp-chat-media").filter({ hasText: name });
					// A remote tab's file comes over the link whole (a blob), so it plays…
					const clip = player("clip.webm").locator("video");
					await expect(clip).toHaveAttribute("src", /^blob:/, { timeout: 20_000 });
					await expect
						.poll(() => clip.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 20_000 })
						.toBeGreaterThanOrEqual(1);
					await expect(player("tone.mp3").locator("audio")).toHaveAttribute("src", /^blob:/, { timeout: 20_000 });
					// …up to the link's cap: the 40 MB take says it is too large instead of loading.
					const long = reply.locator("[data-chat-media-too-large='video']").filter({ hasText: "long.mp4" });
					await long.scrollIntoViewIfNeeded();
					await expect(long).toBeVisible({ timeout: 20_000 });
					await expect(reply.locator("[data-chat-file='pdf']")).toHaveAttribute("data-state", "ready", {
						timeout: 20_000,
					});
					expect(await exists(clientFile("out/clip.webm"))).toBe(false);
					await capture(a, `${language}-${theme}-media`);

					await fs.mkdir(hostFile("docs"));
					await Promise.all([
						fs.writeFile(hostFile("docs/q3.xlsx"), await tinyXlsx()),
						fs.writeFile(hostFile("docs/deck.pptx"), await tinyPptx()),
						fs.writeFile(hostFile("docs/table.csv"), "Region,Total\nNorth,1234.5\nSouth,980\n"),
					]);
					await input.fill("fixture documents");
					await input.press("Enter");
					const cards = a.getByRole("group", { name: t("chat.media.referenced") }).last();
					await expect(cards.locator("[data-file-card]")).toHaveCount(4, { timeout: 30_000 });
					await expect(cards.locator('[data-file-card="spreadsheet"][data-state="ready"]')).toContainText(
						"Excel · ",
					);
					await expect(cards.locator('[data-file-card="csv"][data-state="ready"]')).toContainText("North");
					await expect(cards.locator('[data-file-card="presentation"][data-state="ready"]')).toContainText(
						"Roadmap 2025",
					);
					await expect(cards.locator('[data-file-card][data-state="missing"]')).toContainText(
						t("fileCard.deleted"),
					);
					await cards.scrollIntoViewIfNeeded();
					await capture(a, `${language}-${theme}-file-cards`);
				});

				await test.step("the context inspector reads the host's omp", async () => {
					// The palette's "context" row opens Stats on This session, where the inspector lives.
					await openDestination(a, "insights", "context");
					const stats = a.locator('section[data-destination="insights"]');
					await expect(stats.getByText(t("contextInspector.cat.memoryFiles"), { exact: true })).toBeVisible({
						timeout: 15_000,
					});
					await stats.getByRole("button", { name: t("contextInspector.open") }).click();
					const sheet = a.getByRole("dialog", { name: t("contextInspector.title") });
					await expect(sheet.getByTestId("context-grid").locator("span")).toHaveCount(200);
					// Only B's omp runs with the oversized context.
					await expect(sheet).toContainText(t("contextInspector.overWindow"));
					await capture(a, `${language}-${theme}-inspector`);
					await a.keyboard.press("Escape");
					await expect(sheet).toHaveCount(0);
				});

				expect((await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === remoteTab)?.device).toBe(
					deviceId,
				);
				expect(client.errors).toEqual([]);
				expect(host.errors).toEqual([]);
			} finally {
				if (client) await exitApp(client.app);
				if (host) await exitApp(host.app);
				await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});

/** A session typed on the host itself, for a device to open: its prompt carries no origin. */
async function seedHostSession(agentDir: string, project: string): Promise<string> {
	const dir = path.join(agentDir, "sessions", "fixture");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "shared-session.jsonl");
	const at = Date.now() - 60_000;
	const lines = [
		{ type: "title", v: 1, title: "Shared session", updatedAt: new Date(at).toISOString() },
		{ type: "session", version: 3, id: "shared-session", timestamp: new Date(at).toISOString(), cwd: project },
		{
			type: "message",
			id: "host-1",
			parentId: null,
			timestamp: new Date(at).toISOString(),
			message: { role: "user", content: [{ type: "text", text: "Typed on the host" }], timestamp: at },
		},
		{
			type: "message",
			id: "host-2",
			parentId: "host-1",
			timestamp: new Date(at + 1).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Answered on the host" }],
				timestamp: at + 1,
				provider: "fixture",
				model: "local-fixture",
				stopReason: "stop",
			},
		},
	];
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

async function sendPrompt(page: Page, text: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(text);
	await input.press("Enter");
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`a host's tab shows the host: settings rows, its appearance, prompt origins, daily limits (${language} ${theme})`, async () => {
			test.setTimeout(240_000);
			const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
			// B speaks the other language in the other theme, so whose appearance shows is visible.
			const hostLanguage: Language = language === "en" ? "ko" : "en";
			const hostTheme: Theme = theme === "light" ? "dark" : "light";
			const tb = (key: string, vars?: Record<string, string | number>) => translate(hostLanguage, key, vars);
			const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-host-")));
			let host: RemoteInstance | null = null;
			let client: RemoteInstance | null = null;
			try {
				const versionFile = path.join(parent, "host-omp-version");
				await fs.writeFile(versionFile, "18.12.6\n");
				const hostProfile = await makeRemoteProfile(parent, "b", {
					language: hostLanguage,
					theme: hostTheme,
					// B's omp: signed in to Anthropic with Sonnet as the default role, at 18.12.6 (the floor) with 18.13.0 out.
					env: {
						OMP_GUI_TEST_LOGIN: "1",
						OMP_GUI_TEST_MODELS: "1",
						OMP_GUI_TEST_VERSION_FILE: versionFile,
						OMP_GUI_TEST_LATEST_OMP: "18.13.0",
					},
				});
				const clientProfile = await makeRemoteProfile(parent, "a", {
					language,
					theme,
					port: hostProfile.port,
				});
				const shared = await seedHostSession(path.join(hostProfile.root, "agent"), hostProfile.project);
				host = await launchRemote(hostProfile);
				client = await launchRemote(clientProfile);
				const a = client.page;
				const b = host.page;
				await a.evaluate(() => window.omp.remote.setDeviceName("Laptop A"));
				const deviceId = await connectHost(b, a, "Host B");
				const localTab = (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.device === undefined);
				if (!localTab) throw new Error("expected A's own tab");

				// ── A opens the session B's user typed in, from B's section of the sidebar ──
				const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
				await section.locator(`[data-device-session=${cssString(shared)}] button[data-roving-item]`).click();
				let remoteTab = "";
				await expect
					.poll(
						async () => {
							const tab = (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.device === deviceId);
							remoteTab = tab?.tabId ?? "";
							return tab?.status;
						},
						{ timeout: 60_000 },
					)
					.toBe("ready");
				await expect(a.getByText("Typed on the host")).toBeVisible({ timeout: 20_000 });

				await test.step("prompt origin: the host's prompt reads 'from Host B' on A", async () => {
					await sendPrompt(a, "Typed on the laptop");
					await expect(a.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(
						1,
						{
							timeout: 30_000,
						},
					);
					// The labels come with the transcript B's omp reads back, as after any reload.
					await a.reload();
					await a.waitForFunction(() => window.omp?.remote != null);
					const from = a.locator("[data-prompt-from]");
					await expect(from).toHaveCount(1, { timeout: 30_000 });
					await expect(from).toHaveText(t("chat.promptFrom", { device: "Host B" }));
					await capture(a, `${language}-${theme}-prompt-origin`);
				});

				const settings = a.locator("[data-settings-page]");
				const openSection = async (id: string) => {
					if (!(await settings.isVisible())) await a.keyboard.press("ControlOrMeta+Comma");
					await settings.locator(`[data-settings-section="${id}"]`).click();
				};
				const closeSettings = async () => {
					await a.keyboard.press("Escape");
					await expect(settings).toHaveCount(0);
				};
				const focusTab = async (tabId: string, row: Locator) => {
					await row.locator("button[data-roving-item]").click();
					await expect
						.poll(async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId)
						.toBe(tabId);
				};

				await test.step("model roles and omp rows are the host's", async () => {
					await openSection("models");
					await expect(a.locator(`[data-settings-device-banner="${deviceId}"]`)).toBeVisible();
					// B's omp: Anthropic signed in, Sonnet on the default role (A's fixture has only its own model).
					const roles = settings.locator("#settings-models-roles");
					await expect(roles.getByText(/Sonnet/).first()).toBeVisible({ timeout: 20_000 });
					await roles.scrollIntoViewIfNeeded();
					await capture(a, `${language}-${theme}-model-roles-host`);

					await openSection("updates");
					// D6: the host's omp row says whose omp it is.
					const ompRow = settings
						.locator("[data-setting-row]")
						.filter({ hasText: t("updates.core.hostDescription", { device: "Host B" }) });
					await expect(ompRow.locator(`[data-device-chip="${deviceId}"]`)).toBeVisible();
					await expect(ompRow).toContainText("18.12.6", { timeout: 30_000 });
					await expect(ompRow).toContainText("18.13.0");
					await expect(ompRow.getByRole("button", { name: t("updates.core.update") })).toBeVisible();
					// B26: the host's OMPdesk, with the version the host reports (the app's own, package.json).
					const desktopRow = settings.locator("#setting-updates-host");
					await expect(desktopRow).toContainText(t("updates.host.name"));
					const hostVersion = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")).version;
					await expect(desktopRow.locator("[data-host-desktop-version]")).toContainText(hostVersion);
					await ompRow.scrollIntoViewIfNeeded();
					await capture(a, `${language}-${theme}-updates-host`);
					await closeSettings();

					// A's own tab: A's roles, and no host omp row.
					// A's own tab's row: its session file once omp named one, else the live tab.
					const own = (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === localTab.tabId);
					const ownRow = a.locator(
						`[data-session-path="tab:${localTab.tabId}"], [data-session-path=${cssString(own?.sessionPath ?? "")}]`,
					);
					await focusTab(localTab.tabId, ownRow.first());
					await openSection("models");
					const ownRoles = settings.locator("#settings-models-roles");
					// The role pickers ("Model for {role}") are loaded once the first one shows.
					const picker = new RegExp(t("modelRoles.select", { role: ".+" }));
					await expect(ownRoles.getByRole("button", { name: picker }).first()).toBeVisible({ timeout: 20_000 });
					await expect(ownRoles).not.toContainText(/sonnet/i);
					await openSection("updates");
					await expect(settings.locator(`[data-device-chip="${deviceId}"]`)).toHaveCount(0);
					await closeSettings();
					await focusTab(remoteTab, section.locator(`[data-device-session=${cssString(shared)}]`));
				});

				await test.step("the host's theme and language while its tab is focused", async () => {
					const scheme = () => a.evaluate(() => document.documentElement.getAttribute("data-theme"));
					expect(await scheme()).toBe(theme);
					await openSection("connections");
					const appearance = settings.locator("#setting-remote-host-appearance");
					await appearance.scrollIntoViewIfNeeded();
					await appearance.getByRole("switch").click();
					await expect.poll(scheme).toBe(hostTheme);
					await expect(settings.locator('[data-settings-section="general"]')).toContainText(
						tb("settings.section.general"),
					);
					await capture(a, `${language}-${theme}-host-appearance`);
					await closeSettings();
					// A local tab brings A's own back, and nothing of B's was saved.
					const own = (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === localTab.tabId);
					await focusTab(
						localTab.tabId,
						a
							.locator(
								`[data-session-path="tab:${localTab.tabId}"], [data-session-path=${cssString(own?.sessionPath ?? "")}]`,
							)
							.first(),
					);
					await expect.poll(scheme).toBe(theme);
					expect(
						JSON.parse(await fs.readFile(path.join(clientProfile.desktop, "prefs.json"), "utf8")),
					).toMatchObject({ language, themeName: theme, useHostAppearance: true });
					await focusTab(remoteTab, section.locator(`[data-device-session=${cssString(shared)}]`));
					await expect.poll(scheme).toBe(hostTheme);
					await openSection("connections");
					await appearance.getByRole("switch").click();
					await expect.poll(scheme).toBe(theme);
					await closeSettings();
				});

				await test.step("daily limits: B caps A's requests, A is told why", async () => {
					const peer = (await b.evaluate(() => window.omp.remote.getState())).host.peers[0];
					if (!peer) throw new Error("expected A among B's devices");
					const used = peer.usage.requests;
					// A typed prompt costs two of A's requests on B: the automatic mode choice's judge
					// (`auto_mode_decide`, a model command in remote/quota-commands.ts) and the turn.
					const limit = used + 2;
					await b.keyboard.press("ControlOrMeta+Comma");
					await b.locator('[data-settings-page] [data-settings-section="connections"]').click();
					const row = b.locator(`[data-remote-peer="${peer.deviceId}"]`);
					await row.getByRole("button", { name: tb("remote.peerMenu", { name: "Laptop A" }) }).click();
					await b.getByRole("menuitem", { name: tb("remote.limits.button") }).click();
					const dialog = b.getByRole("dialog", { name: tb("remote.limits.title", { name: "Laptop A" }) });
					await dialog.getByLabel(tb("remote.limits.requests")).fill(String(limit));
					await dialog.getByRole("button", { name: tb("common.save"), exact: true }).click();
					await expect(dialog).toHaveCount(0);

					await sendPrompt(a, "Within the limit");
					await expect(a.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(
						2,
						{
							timeout: 30_000,
						},
					);
					await sendPrompt(a, "Over the limit");
					const toast = a.getByRole("alert").filter({ hasText: t("input.sendFailed") });
					await expect(toast).toContainText(t("ipcError.remote_limit_reached"));
					// The refused prompt stays in the composer, not in the transcript.
					await expect(a.locator("textarea").first()).toHaveValue("Over the limit");
					await capture(a, `${language}-${theme}-limit-reached`);
					await expect(row.locator("[data-peer-usage]")).toContainText(`${limit}/${limit}`);
					await row.scrollIntoViewIfNeeded();
					await capture(b, `${language}-${theme}-host-limits`);
					await b.keyboard.press("Escape");
				});

				await test.step("prompt origin: on B, A's prompt reads 'from Laptop A'", async () => {
					// A's tab closes; its omp kept writing the session it continued, as stock does: the shared file.
					await a.keyboard.press("ControlOrMeta+w");
					await expect
						.poll(async () =>
							(await a.evaluate(() => window.omp.tabs.list())).some(tab => tab.device === deviceId),
						)
						.toBe(false);
					await expect.poll(() => fs.readFile(shared, "utf8")).toContain("Typed on the laptop");
					await b.locator(`[data-session-path=${cssString(shared)}] button[data-roving-item]`).click();
					const from = b.locator("[data-prompt-from]");
					await expect(from.first()).toBeVisible({ timeout: 30_000 });
					await expect(from.first()).toHaveText(tb("chat.promptFrom", { device: "Laptop A" }));
					await capture(b, `${language}-${theme}-host-prompt-origin`);
				});

				expect(client.errors).toEqual([]);
				expect(host.errors).toEqual([]);
			} finally {
				if (client) await exitApp(client.app);
				if (host) await exitApp(host.app);
				await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
