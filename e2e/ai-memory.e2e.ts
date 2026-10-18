/**
 * ai-memory (OMPdesk's memory) end to end with the fake binary (`e2e/fixture/fake-ai-memory.ts`, run as
 * `OMP_GUI_AI_MEMORY_BIN`) in a private HOME and agent dir: nothing of the developer's machine, service or ~/.omp is
 * touched.
 *
 * One launch wires omp with ai-memory's OWN installer commands (`setup --plan --json --agent omp`, then
 * `setup --yes --agent omp`; OMPdesk writes nothing by hand), a new session's omp sees the generated extension at
 * spawn, Settings shows exactly one Memory (ai-memory) section and no stock memory rows, and the side panel's
 * Memory view reads the server (status, search, recent pages, handoffs). Delete-all-memory runs the uninstall, wipes
 * wiki/db/raw itself and wires again. The switch off runs `uninstall --apply --yes` (extension and MCP entry gone, the
 * server stopped, the pref stored); a relaunch stays off and runs no ai-memory command; the switch on wires again.
 *
 * Never clicked: "Open console" (it would open the developer's browser) and "Copy console password" (it would
 * replace the developer's clipboard); their buttons are only checked to be enabled. The clipboard and `openWeb`
 * handlers are unit-tested (`src/main/ai-memory/ipc.test.ts`).
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import type { AiMemoryPhase } from "../src/shared/ai-memory";
import { type FixtureAiMemory, fixtureAiMemory } from "./fixture/fake-ai-memory-install";
import { exitApp, launchApp, pressShortcutUntilVisible, readRecords } from "./harness";

const PLAN = "setup --plan --json --agent omp";
const SETUP = "setup --yes --agent omp";
const UNINSTALL = "uninstall --apply --yes";
const INIT = "init";
const EXTENSION = path.join("extensions", "ai-memory-omp.ts");

interface Rig {
	root: string;
	home: string;
	desktop: string;
	agent: string;
	project: string;
	record: string;
	memory: FixtureAiMemory;
}

interface Launched {
	app: ElectronApplication;
	page: Page;
	errors: string[];
}

async function makeRig(): Promise<Rig> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-ai-memory-")));
	const rig: Rig = {
		root,
		home: path.join(root, "home"),
		desktop: path.join(root, "desktop"),
		agent: path.join(root, "agent"),
		project: path.join(root, "project"),
		record: path.join(root, "rpc.jsonl"),
		memory: await fixtureAiMemory(root),
	};
	await Promise.all([rig.home, rig.desktop, rig.agent, rig.project].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(rig.desktop, "prefs.json"),
		JSON.stringify({ firstRunComplete: true, language: "en", themeName: "light" }),
	);
	return rig;
}

async function launch(rig: Rig): Promise<Launched> {
	const app = await launchApp({
		project: rig.project,
		desktop: rig.desktop,
		agent: rig.agent,
		profile: rig.root,
		env: {
			...rig.memory.env,
			HOME: rig.home,
			USERPROFILE: rig.home,
			PI_CONFIG_DIR: "omp-config",
			AI_MEMORY_DATA_DIR: undefined,
			OMP_GUI_TEST_RECORD: rig.record,
			OMP_GUI_TEST_RECORD_AGENT_FILE: EXTENSION,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page, errors };
}

const state = (page: Page) => page.evaluate(() => window.omp.aiMemory.getState());

/** Wait for a phase; a miss reports the whole state (its `detail` says why wiring failed). */
async function phaseIs(page: Page, phase: AiMemoryPhase): Promise<void> {
	try {
		await expect.poll(async () => (await state(page)).phase, { timeout: 60_000 }).toBe(phase);
	} catch (error) {
		throw new Error(`ai-memory never reached ${phase}: ${JSON.stringify(await state(page))}`, { cause: error });
	}
}

/** The server pid the fake recorded, and whether that process still runs. */
async function serverPid(rig: Rig): Promise<number | null> {
	const text = await fs.readFile(path.join(rig.home, ".fake-ai-memory", "server.pid"), "utf8").catch(() => "");
	return Number(text) || null;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Only ai-memory's own setup calls count: the `--version` probe is not a change to the machine. */
async function commands(rig: Rig): Promise<string[]> {
	return (await rig.memory.invocations()).filter(call => call !== "--version");
}

async function openSettings(page: Page) {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="memory"]').click();
	await expect(settings.locator("#settings-memory")).toBeVisible();
	return settings;
}

test("ai-memory wires omp with its own installer, shows one memory section, and follows the switch", async () => {
	test.setTimeout(240_000);
	const rig = await makeRig();
	const dataDir = path.join(rig.home, "ai-memory-data");
	let current: Launched | null = null;
	try {
		current = await launch(rig);
		let { page } = current;

		await test.step("launch wires omp with ai-memory's own commands and reaches ready", async () => {
			await phaseIs(page, "ready");
			// A fresh data dir: ai-memory's own `init`, OMPdesk's one config edit (no local embedding model), then setup.
			expect(await commands(rig)).toEqual([PLAN, INIT, SETUP]);
			expect(await fs.readFile(path.join(dataDir, "config.toml"), "utf8")).toMatch(/^embedding_provider = "none"/m);
			// Nothing but ai-memory's installer wrote the wiring, and it never purged with ai-memory's own flag.
			expect((await rig.memory.invocations()).join(" ")).not.toContain("--purge-data");
			expect(existsSync(path.join(rig.agent, EXTENSION))).toBe(true);
			const mcp = JSON.parse(await fs.readFile(path.join(rig.agent, "mcp.json"), "utf8"));
			expect(Object.keys(mcp.mcpServers)).toEqual(["ai-memory"]);
			const config = await fs.readFile(path.join(dataDir, "config.toml"), "utf8");
			const bind = /bind\s*=\s*"([^"]+)"/.exec(config)?.[1];
			expect(await state(page)).toMatchObject({
				enabled: true,
				phase: "ready",
				step: null,
				source: "bundled",
				binary: rig.memory.bin,
				dataDir,
				serverUrl: `http://${bind}`,
				webUrl: `http://${bind}/web`,
				wiring: { extension: true, mcp: true },
				stats: { pages: 4, sessions: 2, observations: 17, diskBytes: 8192 },
			});
			// The status reads went out with the bearer token.
			const requests = await rig.memory.requests();
			expect(requests.some(request => request.path === "/admin/status" && request.authorized)).toBe(true);
			expect(requests.filter(request => request.path !== "/healthz").every(request => request.authorized)).toBe(
				true,
			);
			expect(await serverPid(rig)).not.toBeNull();
		});

		await test.step("a new session's omp sees the extension at spawn", async () => {
			const tabs = () => page.evaluate(() => window.omp.tabs.list());
			const [startup] = await tabs();
			await expect(async () => {
				if ((await tabs()).length < 2) await page.keyboard.press("ControlOrMeta+t");
				await expect.poll(async () => (await tabs()).length, { timeout: 2_000 }).toBe(2);
			}).toPass({ timeout: 20_000 });
			const fresh = (await tabs()).find(tab => tab.tabId !== startup?.tabId);
			if (!fresh) throw new Error("No new tab");
			await expect.poll(async () => (await tabs()).find(tab => tab.tabId === fresh.tabId)?.status).toBe("ready");
			const response = await page.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "get_state" }),
				fresh.tabId,
			);
			const sessionId = (response.data as { sessionId?: string } | undefined)?.sessionId;
			const launches = (await readRecords(rig.record)).filter(
				entry => entry.type === "launch" && entry.recordedBy === sessionId,
			);
			expect(launches).toHaveLength(1);
			expect(launches[0]?.agentFile).toBe(true);
		});

		await test.step("the side panel's Memory view shows the server's data", async () => {
			const aside = page.locator("aside[data-docked]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
			await aside.getByRole("button", { name: "View options", exact: true }).click();
			await page.getByRole("menuitemcheckbox", { name: "Memory", exact: true }).click();
			const panel = aside.locator("[data-ai-memory-panel]");
			await expect(panel).toBeVisible();
			await expect(panel.locator("[data-ai-memory-header]")).toContainText(/4 pages · 2 sessions · 17 observations/);
			await expect(panel.locator("[data-ai-memory-recent]")).toContainText("Session: fix the cache");
			await expect(panel.locator("[data-ai-memory-recent]")).toContainText("Use SQLite for the cache");
			await expect(panel.locator("[data-ai-memory-handoffs]")).toContainText(
				"Cache fix half done; next: add the eviction test.",
			);
			await panel.locator("[data-ai-memory-search] input").fill("sqlite");
			await panel.locator("[data-ai-memory-search] input").press("Enter");
			const results = panel.locator("[data-ai-memory-results]");
			await expect(results).toContainText("Use SQLite for the cache");
			// ai-memory marks hits with <mark>; the panel shows plain text.
			await expect(results).toContainText("We chose SQLite for the cache");
			await expect(results.locator("mark")).toHaveCount(0);
			await results.locator('[data-ai-memory-page="decisions/0007-db.md"]').click();
			await expect(panel.locator("[data-ai-memory-page-text]")).toContainText("it ships with Bun");
		});

		await test.step("Settings shows exactly one memory section and no stock memory rows", async () => {
			const settings = await openSettings(page);
			await expect(settings.locator('[data-settings-section="memory"]')).toHaveCount(1);
			await expect(settings.locator("#settings-memory")).toHaveCount(1);
			await expect(settings.locator("#settings-memory")).toContainText("Memory (ai-memory)");
			const section = settings.locator("#settings-memory");
			await expect(section.locator("#setting-aiMemory [role='switch']")).toHaveAttribute("aria-checked", "true");
			await expect(section.locator("[data-ai-memory-status]")).toContainText("Running");
			await expect(section.locator("[data-ai-memory-dir]")).toHaveText(dataDir);
			await expect(section.getByRole("button", { name: "Open console", exact: true })).toBeEnabled();
			await expect(section.getByRole("button", { name: "Copy console password", exact: true })).toBeEnabled();
			await expect(section.getByRole("button", { name: "Delete all memory", exact: true })).toBeVisible();

			// Every Settings section: no stock memory backend rows (memory.backend, mnemopi, hindsight).
			const ids: string[] = [];
			let text = "";
			const sectionNames = await settings
				.locator("[data-settings-section]")
				.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-settings-section") ?? ""));
			for (const name of sectionNames) {
				await settings.locator(`[data-settings-section="${name}"]`).click();
				ids.push(...(await settings.locator("[id^='setting-']").evaluateAll(nodes => nodes.map(node => node.id))));
				text += `\n${await settings.innerText()}`;
			}
			expect(ids.filter(id => /^setting-(memory\.|mnemopi|hindsight)/i.test(id))).toEqual([]);
			expect(text).not.toMatch(/mnemopi|hindsight|memory\.backend/i);
			expect(ids).toContain("setting-aiMemory");
			await settings.locator('[data-settings-section="memory"]').click();
		});

		await test.step("Delete all memory asks first, then uninstalls, wipes wiki/db/raw itself and wires again", async () => {
			const settings = page.locator("[data-settings-page]");
			for (const folder of ["wiki", "db", "raw"]) {
				await fs.mkdir(path.join(dataDir, folder), { recursive: true });
				await fs.writeFile(path.join(dataDir, folder, "page"), "remembered");
			}
			const del = settings
				.locator("#settings-memory")
				.getByRole("button", { name: "Delete all memory", exact: true });
			await del.click();
			const dialog = page.getByRole("dialog");
			await expect(dialog).toContainText("Delete all memory?");
			await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
			await expect(dialog).toHaveCount(0);
			// Cancelled: nothing ran and nothing was deleted.
			expect(await commands(rig)).toEqual([PLAN, INIT, SETUP]);
			expect(existsSync(path.join(dataDir, "wiki", "page"))).toBe(true);

			const before = await serverPid(rig);
			await del.click();
			await dialog.getByRole("button", { name: "Delete all memory", exact: true }).click();
			await expect(page.getByText("All memory deleted")).toBeVisible({ timeout: 60_000 });
			expect(await commands(rig)).toEqual([PLAN, INIT, SETUP, UNINSTALL, PLAN, SETUP]);
			expect((await rig.memory.invocations()).join(" ")).not.toContain("--purge-data");
			for (const folder of ["wiki", "db", "raw"]) expect(existsSync(path.join(dataDir, folder))).toBe(false);
			// The config and token stay; the server runs again (a new process) and memory is on.
			expect(existsSync(path.join(dataDir, "config.toml"))).toBe(true);
			expect(existsSync(path.join(dataDir, "auth-tokens", "default"))).toBe(true);
			await phaseIs(page, "ready");
			expect(await serverPid(rig)).not.toBe(before);
		});

		await test.step("the switch off uninstalls, stops the server and stores the choice", async () => {
			const settings = page.locator("[data-settings-page]");
			const pidBefore = await serverPid(rig);
			if (!pidBefore) throw new Error("no server pid");
			await settings.locator("#setting-aiMemory [role='switch']").click();
			await expect(settings.locator("#setting-aiMemory [role='switch']")).toHaveAttribute("aria-checked", "false");
			await phaseIs(page, "off");
			expect(await commands(rig)).toEqual([PLAN, INIT, SETUP, UNINSTALL, PLAN, SETUP, UNINSTALL]);
			expect(await state(page)).toMatchObject({
				enabled: false,
				wiring: { extension: false, mcp: false },
				stats: null,
			});
			expect(existsSync(path.join(rig.agent, EXTENSION))).toBe(false);
			const mcp = JSON.parse(await fs.readFile(path.join(rig.agent, "mcp.json"), "utf8"));
			expect(mcp.mcpServers["ai-memory"]).toBeUndefined();
			// The data stays; the server is gone.
			expect(existsSync(path.join(dataDir, "config.toml"))).toBe(true);
			expect(await serverPid(rig)).toBeNull();
			await expect.poll(() => isAlive(pidBefore)).toBe(false);
			await expect(settings.locator("[data-ai-memory-status]")).toContainText("Off");
			await expect
				.poll(async () => JSON.parse(await fs.readFile(path.join(rig.desktop, "prefs.json"), "utf8")).aiMemory)
				.toBe(false);
		});

		await test.step("a relaunch stays off and runs no ai-memory command", async () => {
			const callsBefore = await rig.memory.invocations();
			await exitApp(current!.app);
			current = await launch(rig);
			page = current.page;
			// The state settles to off without any command.
			await phaseIs(page, "off");
			expect(await state(page)).toMatchObject({ enabled: false, wiring: { extension: false, mcp: false } });
			const settings = await openSettings(page);
			await expect(settings.locator("#setting-aiMemory [role='switch']")).toHaveAttribute("aria-checked", "false");
			expect(await rig.memory.invocations()).toEqual(callsBefore);
			expect(await serverPid(rig)).toBeNull();
		});

		await test.step("the switch on wires again", async () => {
			const settings = page.locator("[data-settings-page]");
			await settings.locator("#setting-aiMemory [role='switch']").click();
			await phaseIs(page, "ready");
			expect((await commands(rig)).slice(-2)).toEqual([PLAN, SETUP]);
			expect(existsSync(path.join(rig.agent, EXTENSION))).toBe(true);
			const mcp = JSON.parse(await fs.readFile(path.join(rig.agent, "mcp.json"), "utf8"));
			expect(mcp.mcpServers["ai-memory"]).toBeDefined();
			await expect(settings.locator("#setting-aiMemory [role='switch']")).toHaveAttribute("aria-checked", "true");
			await expect(settings.locator("[data-ai-memory-status]")).toContainText("Running");
			await expect
				.poll(async () => JSON.parse(await fs.readFile(path.join(rig.desktop, "prefs.json"), "utf8")).aiMemory)
				.toBe(true);
		});

		expect(current.errors).toEqual([]);
	} finally {
		if (current) await exitApp(current.app);
		// The fake server is detached on purpose (like ai-memory's own service): stop it with the test.
		const pid = await serverPid(rig);
		if (pid && isAlive(pid)) process.kill(pid);
		await fs.rm(rig.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
