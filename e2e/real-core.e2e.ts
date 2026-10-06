import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { RpcSessionState } from "../src/shared/rpc-types";
import { exitApp } from "./harness";

test("system omp persists settings and sessions and serves every stats route", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-real-core-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			launchProfiles: {
				[project]: { noExtensions: true, noSkills: true, noRules: true },
			},
		}),
	);
	await fs.writeFile(path.join(project, "README.md"), "# Local ARM audit\n");
	// A persisted session for the restore-from-disk path. Stock omp writes a
	// session file only after a model reply, which this credential-less profile
	// cannot produce, so seed one in the stock JSONL format.
	const seededSession = path.join(agent, "sessions", "seeded", "seeded-session.jsonl");
	await fs.mkdir(path.dirname(seededSession), { recursive: true });
	const at = new Date().toISOString();
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	await fs.writeFile(
		seededSession,
		[
			{ type: "session", version: 3, id: "01a11000-0000-7000-8000-00000000seed", timestamp: at, cwd: project },
			{
				type: "message",
				id: "seed0001",
				parentId: null,
				timestamp: at,
				message: { role: "user", content: [{ type: "text", text: "run the audit" }], timestamp: Date.now() },
			},
			{
				type: "message",
				id: "seed0002",
				parentId: "seed0001",
				timestamp: at,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "arm audit ok" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-5-5",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero },
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n")
			.concat("\n"),
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	Reflect.deleteProperty(env, "OMP_GUI_OMP");
	const executablePath = process.env.OMP_GUI_TEST_APP;
	const app = await electron.launch({
		...(executablePath ? { executablePath } : {}),
		args: [...(executablePath ? [] : [path.resolve("out/main/index.js")]), project, `--user-data-dir=${desktop}`],
		env,
	});
	const mainOutput: string[] = [];
	app.process().stdout?.on("data", (chunk: Buffer) => mainOutput.push(chunk.toString()));
	app.process().stderr?.on("data", (chunk: Buffer) => mainOutput.push(chunk.toString()));
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	const closeWelcomeIfPresent = async (title: string, closeLabel: string) => {
		const welcome = page.getByRole("dialog", { name: title, exact: true });
		if ((await welcome.count()) === 0) return;
		await expect(welcome).toBeVisible();
		await welcome.getByRole("button", { name: closeLabel, exact: true }).click();
		await expect(welcome).toHaveCount(0);
	};
	try {
		// The whole payload, so a failure prints the sidecar's error message too.
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		const runtime = await app.evaluate(({ app }) => ({
			isPackaged: app.isPackaged,
			appPath: app.getAppPath(),
			executable: process.execPath,
			resourcesPath: process.resourcesPath,
			pid: process.pid,
			sidecarOverride: process.env.OMP_GUI_OMP ?? null,
		}));
		if (executablePath) {
			expect(runtime.isPackaged).toBe(true);
			expect(runtime.sidecarOverride).toBeNull();
		}
		await fs.writeFile("test-results/runtime-selection.json", JSON.stringify(runtime, null, 2));
		const evidence = await page.evaluate(
			async exportPath => {
				const rpc = window.omp.rpc;
				const before = await rpc.getState();
				const settings = await rpc.getSettings();
				const schema = await rpc.getSettingsSchema();
				const changed = await rpc.setSetting("compaction.enabled", false);
				const effective = await rpc.getState();
				const changes = await rpc.getGitChanges();
				const jobs = await rpc.getJobs();
				const shell = await rpc.bash("printf 'arm audit ok'");
				// Stock omp writes the session file only after a model reply, so a
				// bash-only session is not restorable: read and export it live.
				const transcript = await rpc.getTranscript();
				const exported = await rpc.exportHtml(exportPath);
				const saved = await rpc.getState();
				const sessionPath = saved.success && (saved.data as RpcSessionState).sessionFile;
				if (!sessionPath) throw new Error("get_state reported no session file");
				const fresh = await rpc.newSession();
				const restored = await rpc.switchSession(sessionPath);
				return {
					before,
					settings,
					schema,
					changed,
					effective,
					changes,
					jobs,
					shell,
					saved,
					fresh,
					restored,
					transcript,
					exported,
				};
			},
			path.join(profile, "audit-export.html"),
		);
		for (const response of Object.values(evidence)) expect(response.success, JSON.stringify(response)).toBe(true);
		expect(evidence.changed.data).toMatchObject({ value: false });
		expect(evidence.effective.data).toMatchObject({ autoCompactionEnabled: false });
		expect(evidence.changes.data).toMatchObject({ isRepo: false });
		await fs.writeFile("test-results/real-core-contract.json", JSON.stringify(evidence, null, 2));
		expect(JSON.stringify(evidence.transcript.data)).toContain("arm audit ok");
		const exportWindow = app.waitForEvent("window");
		await app.evaluate(
			({ BrowserWindow }, url) => {
				// A never-shown window does not paint on Windows, so screenshots hang;
				// show it inactive like every headless window (transparent, unfocusable).
				const win = new BrowserWindow({ width: 1100, height: 800, show: false, focusable: false });
				win.showInactive();
				void win.loadURL(url);
			},
			pathToFileURL(path.join(profile, "audit-export.html")).href,
		);
		const exportPage = await exportWindow;
		await expect(exportPage.locator("#messages")).toContainText("arm audit ok");
		await exportPage.screenshot({ path: "test-results/exported-session.png", scale: "css", animations: "disabled" });
		await exportPage.close();
		await page.screenshot({ path: "test-results/04-real-core.png", scale: "css", animations: "disabled" });
		await expect(page.getByRole("dialog", { name: "Welcome to omp" })).toBeVisible();
		await page
			.getByRole("dialog", { name: "Welcome to omp" })
			.getByRole("button", { name: "Close", exact: true })
			.click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		const original = evidence.saved.data as RpcSessionState;
		await page.locator("textarea").first().fill("/new");
		await page.getByRole("button", { name: "Send (Enter)", exact: true }).click();
		await expect
			.poll(async () => {
				const state = await page.evaluate(() => window.omp.rpc.getState());
				return state.success ? (state.data as RpcSessionState).sessionId : original.sessionId;
			})
			.not.toBe(original.sessionId);
		await expect(page.getByText("The originating session was replaced or closed.", { exact: false })).toHaveCount(0);
		// The seeded reply names a model this credential-less profile cannot
		// restore, and stock omp fails such a switch closed. Bind the session to
		// the model omp booted on, as the app's model-restore prompt does.
		await page.evaluate(async sessionPath => {
			const state = await window.omp.rpc.getState();
			const model = state.success ? (state.data as RpcSessionState).model : null;
			const result = await window.omp.rpc.switchSession(
				sessionPath,
				model ? { provider: model.provider, modelId: model.id } : undefined,
			);
			if (!result.success) throw new Error(result.error);
		}, seededSession);
		await page.reload();
		await expect(page.locator("[data-transcript-kind]").filter({ hasText: "arm audit ok" })).toHaveCount(1);
		await closeWelcomeIfPresent("Welcome to omp", "Close");
		await page.getByRole("button", { name: "Session stats", exact: true }).click();
		const stats = page.getByRole("dialog");
		await expect(stats).toBeVisible();
		for (const label of [
			"Overview",
			"Models",
			"Providers",
			"Tools",
			"Costs",
			"Errors",
			"Frustration",
			"Gain",
			"Projects",
			"Requests",
		]) {
			await stats.locator("nav").getByRole("button", { name: label, exact: true }).click();
			await expect(stats.getByText("Loading stats…", { exact: true })).toHaveCount(0, { timeout: 30000 });
			await expect(stats).not.toContainText("Stats unavailable", { timeout: 15000 });
			await page.screenshot({ path: `test-results/stats-${label}.png`, scale: "css", animations: "disabled" });
		}
		await page.keyboard.press("Escape");
		await page.evaluate(async () => {
			await window.omp.prefs.set("language", "zh");
		});
		await page.reload();
		await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
		// No provider in this profile, so onboarding always opens once readiness is checked.
		const zhWelcome = page.getByRole("dialog", { name: "欢迎使用 omp" });
		await expect(zhWelcome).toBeVisible();
		await zhWelcome.getByRole("button", { name: "关闭", exact: true }).click();
		await expect(zhWelcome).toHaveCount(0);
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await expect(page.getByRole("dialog")).toContainText("权限与安全");
		await expect(page.getByRole("dialog").locator(".settings-nav-group-label")).toHaveCount(8);
		const settingsPages: Array<{ group: string; page: string; text: string }> = [];
		for (let groupIndex = 0; groupIndex < 8; groupIndex++) {
			const settings = page.getByRole("dialog");
			const group = settings.locator(".settings-nav-group-label").nth(groupIndex);
			const groupName = await group.innerText();
			await group.click();
			const pages = settings.locator(".settings-nav-item");
			const count = await pages.count();
			for (let pageIndex = 0; pageIndex < count; pageIndex++) {
				const target = pages.nth(pageIndex);
				const pageName = await target.innerText();
				await target.click();
				await expect(settings.locator(".settings-content .animate-spin")).toHaveCount(0, { timeout: 30_000 });
				const content = settings.locator(".settings-content");
				await expect(content).not.toContainText("Something went wrong");
				await expect(content).not.toContainText("Typo Detection (macOS)");
				await expect(content).not.toContainText("Word Autocomplete (macOS)");
				await expect(content).not.toContainText("Autocorrect (macOS)");
				settingsPages.push({ group: groupName, page: pageName, text: await content.innerText() });
				await page.screenshot({
					path: `test-results/settings-${groupIndex}-${pageIndex}.png`,
					scale: "css",
					animations: "disabled",
				});
			}
		}
		await fs.writeFile("test-results/settings-pages.json", JSON.stringify(settingsPages, null, 2));
		const settingsSearch = page.getByRole("dialog").getByPlaceholder("搜索设置和管理资源…");
		await settingsSearch.fill("bash.patterns");
		await page.getByRole("button", { name: /Bash 审批模式 bash.patterns/ }).click();
		const rules = page.locator('[title="bash.patterns"]').locator("..").locator("..");
		await expect(rules.locator("textarea")).toHaveValue("[]");
		const rule = { match: "echo audit-blocked", approval: "deny" };
		await rules.locator("textarea").fill(JSON.stringify([rule]));
		await rules.getByRole("button", { name: "应用", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["bash.patterns"])))
			.toMatchObject({ success: true, data: { values: { "bash.patterns": [rule] } } });
		await rules.locator("textarea").fill("[]");
		await rules.getByRole("button", { name: "应用", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["bash.patterns"])))
			.toMatchObject({ success: true, data: { values: { "bash.patterns": [] } } });
		await page.getByRole("dialog").getByRole("button", { name: "外观与使用", exact: true }).click();
		await expect(page.getByRole("dialog")).toContainText("选择 GUI 主题");
		await page.screenshot({ path: "test-results/05-packaged-zh.png", scale: "css", animations: "disabled" });
		await page.keyboard.press("Escape");
		const backgrounds: string[] = [];
		for (const theme of ["瓷白", "石墨"]) {
			await page.getByRole("button", { name: "选择主题", exact: true }).click();
			const picker = page.getByRole("dialog", { name: "选择主题", exact: true });
			await picker.getByPlaceholder("搜索主题…").fill(theme);
			await picker.locator("button[aria-pressed]").filter({ hasText: theme }).click();
			await expect(picker).toHaveCount(0);
			backgrounds.push(
				await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary")),
			);
			await page.screenshot({
				path: `test-results/packaged-theme-${theme}.png`,
				scale: "css",
				animations: "disabled",
			});
		}
		expect(backgrounds[0]).not.toBe(backgrounds[1]);
		// Delay the real IPC boot snapshot while the user makes a newer choice.
		const bootPrefs = await page.evaluate(async () => {
			await window.omp.prefs.set("fontSize", 18);
			return window.omp.prefs.get();
		});
		await app.evaluate(({ ipcMain }, prefs) => {
			const pending = Promise.withResolvers<void>();
			Reflect.set(globalThis, "releaseAuditPrefs", pending.resolve);
			ipcMain.removeHandler("prefs:get");
			ipcMain.handle("prefs:get", async (_event, payload: { key?: string }) => {
				if (payload.key) return (prefs as Record<string, unknown>)[payload.key];
				Reflect.set(globalThis, "auditPrefsRequested", true);
				await pending.promise;
				return prefs;
			});
		}, bootPrefs);
		await page.reload();
		await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "auditPrefsRequested"))).toBe(true);
		await expect(page.getByRole("button", { name: "选择主题", exact: true })).toBeVisible();
		await closeWelcomeIfPresent("欢迎使用 omp", "关闭");
		await page.getByRole("button", { name: "选择主题", exact: true }).click();
		const freshPicker = page.getByRole("dialog", { name: "选择主题", exact: true });
		await freshPicker.getByPlaceholder("搜索主题…").fill("瓷白");
		await freshPicker.locator("button[aria-pressed]").filter({ hasText: "瓷白" }).click();
		await expect(freshPicker).toHaveCount(0);
		const chosenBackground = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary"),
		);
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("dialog").getByRole("button", { name: "外观与使用", exact: true }).click();
		const font = page.locator('#setting-gui-fontSize input[type="number"]');
		const chosenFont = await font.inputValue();
		for (const value of [String(Number(chosenFont) + 1), chosenFont]) {
			await font.fill(value);
			await font.press("Enter");
			await expect
				.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--gui-font-size")))
				.toBe(`${value}px`);
		}
		await page.keyboard.press("Escape");
		await app.evaluate(() => Reflect.get(globalThis, "releaseAuditPrefs")());
		await page.evaluate(async () => {
			await window.omp.prefs.get();
			const { promise, resolve } = Promise.withResolvers<void>();
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			await promise;
		});
		expect(
			await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary")),
		).toBe(chosenBackground);
		expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--gui-font-size"))).toBe(
			`${chosenFont}px`,
		);
		expect(errors).toEqual([]);
	} finally {
		await fs.writeFile("test-results/main-process.log", mainOutput.join(""));
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true });
	}
});
