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
	// A persisted session for the restore-from-disk path, in the stock JSONL
	// format. It holds a user turn and a `!` bash run, as this credential-less
	// profile can produce: an assistant reply would name a model, and omp ≥ 18.6.3
	// refuses to open a session whose saved model it cannot restore. Written once
	// omp reports its cwd: stock refuses a session recorded elsewhere, and Windows
	// temp paths come back long-named where os.tmpdir() spells them 8.3.
	const seededSession = path.join(agent, "sessions", "seeded", "seeded-session.jsonl");
	const seedSession = async (cwd: string) => {
		await fs.mkdir(path.dirname(seededSession), { recursive: true });
		const at = new Date().toISOString();
		await fs.writeFile(
			seededSession,
			[
				{ type: "session", version: 3, id: "01a11000-0000-7000-8000-00000000seed", timestamp: at, cwd },
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
						role: "bashExecution",
						command: "printf 'arm audit ok'",
						output: "arm audit ok",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						timestamp: Date.now(),
					},
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")
				.concat("\n"),
		);
	};
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
	try {
		// Inside the try: a launch whose window never shows still leaves
		// main-process.log behind and is torn down by exitApp.
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		// First run is inline in the empty main area (no dialog); it only shows on an
		// empty session, so it is dismissed where present rather than asserted.
		const dismissSetupIfPresent = async (title: string, laterLabel: string) => {
			const setup = page.getByRole("region", { name: title, exact: true });
			if ((await setup.count()) === 0) return;
			await setup.getByRole("button", { name: laterLabel, exact: true }).click();
			await expect(setup).toHaveCount(0);
		};
		// The whole payload, so a failure prints the sidecar's error message too.
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		// No provider in this profile (Apple's keyless on-device model does not
		// count), so the inline first-run setup takes the empty session.
		const setup = page.getByRole("region", { name: "Set up OMPdesk", exact: true });
		await expect(setup).toBeVisible();
		await expect(setup.getByRole("searchbox", { name: "Search providers" })).toBeVisible();
		await setup.getByRole("button", { name: "Set up later", exact: true }).click();
		await expect(setup).toHaveCount(0);
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
		await expect(page.getByRole("dialog")).toHaveCount(0);
		const original = evidence.saved.data as RpcSessionState;
		await page.locator("textarea").first().fill("/new");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect
			.poll(async () => {
				const state = await page.evaluate(() => window.omp.rpc.getState());
				return state.success ? (state.data as RpcSessionState).sessionId : original.sessionId;
			})
			.not.toBe(original.sessionId);
		await expect(page.getByText("The originating session was replaced or closed.", { exact: false })).toHaveCount(0);
		await seedSession(original.cwd);
		await page.evaluate(async sessionPath => {
			const result = await window.omp.rpc.switchSession(sessionPath);
			if (!result.success) throw new Error(result.error);
			const { data } = result;
			if (data && typeof data === "object" && "cancelled" in data && data.cancelled === true) {
				throw new Error("switch_session was cancelled");
			}
		}, seededSession);
		await page.reload();
		await expect(page.locator("[data-transcript-kind]").filter({ hasText: "arm audit ok" })).toHaveCount(1);
		await dismissSetupIfPresent("Set up OMPdesk", "Set up later");
		const artifacts = seededSession.slice(0, -6);
		await fs.mkdir(path.join(artifacts, "nested"), { recursive: true });
		await fs.writeFile(path.join(artifacts, "nested", "artifact.txt"), "session artifact");
		await fs.copyFile(seededSession, `${seededSession}.123.bak`);
		const dropped = await page.evaluate(() => window.omp.rpc.dropSession());
		expect(dropped.success).toBe(true);
		await expect(fs.access(seededSession)).rejects.toThrow();
		await expect(fs.access(artifacts)).rejects.toThrow();
		await expect(fs.access(`${seededSession}.123.bak`)).rejects.toThrow();
		const afterDrop = await page.evaluate(() => window.omp.rpc.getState());
		expect(afterDrop.success).toBe(true);
		if (afterDrop.success) expect((afterDrop.data as RpcSessionState).sessionFile).not.toBe(seededSession);
		await page.locator('[data-sidebar-destinations] button[data-destination="insights"]').click();
		const stats = page.locator('section[data-destination="insights"]');
		await expect(stats).toBeVisible();
		// The global dashboard sections live under Stats › All sessions (default scope is This session).
		await stats.getByRole("tab", { name: "Activity", exact: true }).click();
		await stats.getByRole("tab", { name: "All sessions", exact: true }).click();
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
			await stats
				.locator('nav[aria-label="Stats sections"]')
				.getByRole("button", { name: label, exact: true })
				.click();
			await expect(stats.getByText("Loading stats…", { exact: true })).toHaveCount(0, { timeout: 30000 });
			await expect(stats).not.toContainText("Couldn't load stats", { timeout: 15000 });
			await page.screenshot({ path: `test-results/stats-${label}.png`, scale: "css", animations: "disabled" });
		}
		await page.keyboard.press("Escape");
		await page.evaluate(async () => {
			await window.omp.prefs.set("language", "ko");
		});
		await page.reload();
		await expect(page.locator('[data-sidebar-destinations] button[data-destination="settings"]')).toContainText(
			"설정",
		);
		await dismissSetupIfPresent("OMPdesk 시작하기", "나중에 설정");
		await page.keyboard.press("ControlOrMeta+Comma");
		const settings = page.locator("[data-settings-page]");
		await expect(settings).toContainText("권한 및 보안");
		const sectionIds = await settings
			.locator("[data-settings-section]")
			.evaluateAll(elements => elements.map(element => element.getAttribute("data-settings-section") ?? ""));
		expect(sectionIds).toHaveLength(11);
		const content = settings.locator(".settings-content");
		const settingsPages: Array<{ page: string; text: string }> = [];
		const capture = async (name: string) => {
			await expect(content.locator(".animate-spin")).toHaveCount(0, { timeout: 30_000 });
			await expect(content).not.toContainText("Something went wrong");
			await expect(content).not.toContainText("Typo Detection (macOS)");
			await expect(content).not.toContainText("Word Autocomplete (macOS)");
			await expect(content).not.toContainText("Autocorrect (macOS)");
			settingsPages.push({ page: name, text: await content.innerText() });
			await page.screenshot({ path: `test-results/settings-${name}.png`, scale: "css", animations: "disabled" });
		};
		for (const id of sectionIds) {
			await settings.locator(`[data-settings-section="${id}"]`).click();
			await capture(id);
		}
		// Each setting belongs to one section; Other settings is only the future-schema fallback.
		await expect(settings.locator("#settings-advanced-category")).toHaveCount(0);
		await fs.writeFile("test-results/settings-pages.json", JSON.stringify(settingsPages, null, 2));
		const settingsSearch = settings.getByRole("searchbox", { name: "설정 검색" });
		await settingsSearch.fill("bash.patterns");
		await settings.getByRole("button", { name: "Bash 승인 패턴", exact: true }).click();
		const rules = settings.locator('[id="setting-bash.patterns"]');
		await expect(rules.locator("textarea")).toHaveValue("[]");
		const rule = { match: "echo audit-blocked", approval: "deny" };
		await rules.locator("textarea").fill(JSON.stringify([rule]));
		await rules.getByRole("button", { name: "적용", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["bash.patterns"])))
			.toMatchObject({ success: true, data: { values: { "bash.patterns": [rule] } } });
		await rules.locator("textarea").fill("[]");
		await rules.getByRole("button", { name: "적용", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["bash.patterns"])))
			.toMatchObject({ success: true, data: { values: { "bash.patterns": [] } } });
		await settings.locator('[data-settings-section="appearance"]').click();
		const themes = settings.getByRole("radiogroup", { name: "테마" });
		await expect(themes).toBeVisible();
		await page.screenshot({ path: "test-results/05-packaged-ko.png", scale: "css", animations: "disabled" });
		const backgrounds: string[] = [];
		for (const theme of ["포슬린", "그래파이트"]) {
			await themes.getByRole("radio", { name: theme }).click();
			await expect(themes.getByRole("radio", { name: theme })).toHaveAttribute("aria-checked", "true");
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
		await page.keyboard.press("Escape");
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
		await dismissSetupIfPresent("OMPdesk 시작하기", "나중에 설정");
		await page.keyboard.press("ControlOrMeta+Comma");
		const freshSettings = page.locator("[data-settings-page]");
		await freshSettings.locator('[data-settings-section="appearance"]').click();
		const freshThemes = freshSettings.getByRole("radiogroup", { name: "테마" });
		await freshThemes.getByRole("radio", { name: "포슬린" }).click();
		await expect(freshThemes.getByRole("radio", { name: "포슬린" })).toHaveAttribute("aria-checked", "true");
		const chosenBackground = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary"),
		);
		const font = freshSettings.locator("#setting-gui-fontSize select");
		const chosenFont = await font.inputValue();
		for (const value of [chosenFont === "16" ? "17" : "16", chosenFont]) {
			await font.selectOption(value);
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
