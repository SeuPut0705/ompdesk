/**
 * ai-memory (OMPdesk's memory) end to end with the fake binary (`e2e/fixture/fake-ai-memory.ts`, run as
 * `OMP_GUI_AI_MEMORY_BIN`) in a private HOME and agent dir: nothing of the developer's machine, service or ~/.omp is
 * touched. The rig plants another agent's ai-memory wiring (a Claude Code `settings.json` that mentions ai-memory) first.
 *
 * One launch sets ai-memory up with its OWN commands (`setup --plan --json --agent omp`, `setup --yes --agent omp`
 * against a scratch agent dir, then the three generators `install-hooks|install-mcp|install-skills` into OMPdesk's own
 * extension root `<userData>/ai-memory/omp-ext`; OMPdesk writes nothing by hand). Nothing lands in omp's agent dir. A new
 * session's omp is spawned with `-e <root>`, Settings shows exactly one Memory (ai-memory) section and no stock memory
 * rows, and the side panel's Memory view reads the server. "Also use in the terminal omp" runs ai-memory's own
 * `setup --agent omp` into the agent dir (new sessions then stop loading the root: no double capture) and its reverse
 * removes just that extension and MCP entry. Delete-all-memory stops the server, wipes wiki/db/raw itself and sets up
 * again. The switch off NEVER runs `uninstall --apply`: the root is gone, new sessions get no `-e`, the planted
 * Claude Code wiring is byte-for-byte untouched, and the server keeps running while that other agent uses it; with it
 * gone, off stops the server. A relaunch stays off and runs no ai-memory command; the switch on sets up again.
 * A second spec: an earlier build's global wiring (running the binary in use) is moved to the root once.
 *
 * Never clicked: "Open console" (it would open the developer's browser) and "Copy console password" (it would
 * replace the developer's clipboard); their buttons are only checked to be enabled. The clipboard and `openWeb`
 * handlers are unit-tested (`src/main/ai-memory/ipc.test.ts`).
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CLAUDE_SETTINGS, type Launched, launch, makeRig, phaseIs, type Rig, state } from "./fixture/ai-memory-rig";
import { exitApp, pressShortcutUntilVisible, readRecords } from "./harness";

const PLAN = "setup --plan --json --agent omp";
const SETUP = "setup --yes --agent omp";
const LISTING = "uninstall";
const INIT = "init";
const EXTENSION = path.join("extensions", "ai-memory-omp.ts");
/** The generator commands, by verb (their path arguments are the rig's temp dirs). */
const GENERATORS = ["install-hooks", "install-mcp", "install-skills"];

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

/**
 * Only ai-memory's own calls count (the `--version` probe is not a change to the machine). The generators' paths are the
 * rig's temp dirs, so each shows as its verb.
 */
async function commands(rig: Rig): Promise<string[]> {
	return (await rig.memory.invocations())
		.filter(call => call !== "--version")
		.map(call => (GENERATORS.includes(call.split(" ")[0] ?? "") ? (call.split(" ")[0] ?? call) : call));
}

/** The launch argv of the omp a tab runs. */
async function launchArgv(page: Page, rig: Rig, tabId: string): Promise<string[]> {
	const response = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), tabId);
	const sessionId = (response.data as { sessionId?: string } | undefined)?.sessionId;
	const launches = (await readRecords(rig.record)).filter(
		entry => entry.type === "launch" && entry.recordedBy === sessionId,
	);
	expect(launches).toHaveLength(1);
	return (launches[0]?.argv as string[] | undefined) ?? [];
}

/** Open a new tab and return its omp's argv. */
async function newSessionArgv(page: Page, rig: Rig): Promise<string[]> {
	const spawned = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
	const tabId = spawned?.tabId;
	if (!tabId) throw new Error("No new tab");
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status)
		.toBe("ready");
	return launchArgv(page, rig, tabId);
}

async function openSettings(page: Page) {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="memory"]').click();
	await expect(settings.locator("#settings-memory")).toBeVisible();
	return settings;
}

test("ai-memory loads through an app-owned root, shows one memory section, and its switch touches only OMPdesk's part", async () => {
	test.setTimeout(240_000);
	const rig = await makeRig();
	const dataDir = path.join(rig.home, "ai-memory-data");
	let current: Launched | null = null;
	try {
		current = await launch(rig);
		let { page } = current;

		await test.step("launch sets ai-memory up with its own commands into OMPdesk's root and reaches ready", async () => {
			await phaseIs(page, "ready");
			// A fresh data dir: ai-memory's own `init`, OMPdesk's one config edit (no local embedding model), then setup
			// (the server's service) and the three generators that fill OMPdesk's own extension root.
			expect(await commands(rig)).toEqual([PLAN, INIT, SETUP, ...GENERATORS]);
			expect(await fs.readFile(path.join(dataDir, "config.toml"), "utf8")).toMatch(/^embedding_provider = "none"/m);
			// Nothing but ai-memory's own commands wrote anything, and it never purged with ai-memory's own flag.
			expect((await rig.memory.invocations()).join(" ")).not.toContain("--purge-data");
			expect(existsSync(path.join(rig.extRoot, "index.ts"))).toBe(true);
			const rootMcp = JSON.parse(await fs.readFile(path.join(rig.extRoot, ".mcp.json"), "utf8"));
			expect(Object.keys(rootMcp.mcpServers)).toEqual(["ai-memory"]);
			expect((await fs.readdir(path.join(rig.extRoot, "skills"))).length).toBeGreaterThan(0);
			// Nothing is written to omp's own agent dir, and the shared skills setup made are taken back.
			expect(existsSync(path.join(rig.agent, EXTENSION))).toBe(false);
			expect(existsSync(path.join(rig.agent, "mcp.json"))).toBe(false);
			expect(existsSync(path.join(rig.home, ".agents", "skills", "ai-memory-retrieval"))).toBe(false);
			expect(await fs.readFile(rig.claude, "utf8")).toBe(CLAUDE_SETTINGS);
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
				wiring: { app: true, terminal: false },
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

		await test.step("a new session's omp is spawned with -e <the app-owned root>", async () => {
			const argv = await newSessionArgv(page, rig);
			expect(argv.join(" ")).toContain(`-e ${rig.extRoot}`);
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
			// The panel is a glance: its button and its rows open the Memory page in Settings.
			await panel.locator("[data-memory-open]").click();
			await expect(page.locator("[data-settings-page] #settings-memory")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(page.locator("[data-settings-page]")).toHaveCount(0);
		});

		await test.step("Settings shows exactly one memory section and no stock memory rows", async () => {
			const settings = await openSettings(page);
			await expect(settings.locator('[data-settings-section="memory"]')).toHaveCount(1);
			await expect(settings.locator("#settings-memory")).toHaveCount(1);
			await expect(settings.locator("#settings-memory")).toContainText("Memory");
			const section = settings.locator("#settings-memory");
			await expect(section.locator("#setting-aiMemory [role='switch']")).toHaveAttribute("aria-checked", "true");
			await expect(section.locator("[data-memory-status]")).toContainText("Running");
			await expect(section.locator("[data-memory-dir]")).toHaveText(dataDir);
			await expect(section.getByRole("button", { name: "Open web console", exact: true })).toBeEnabled();
			await expect(section.getByRole("button", { name: "Copy password", exact: true })).toBeEnabled();
			await section.getByRole("tab", { name: "Maintenance" }).click();
			await expect(section.getByRole("button", { name: "Delete all memory", exact: true })).toBeVisible();
			await section.getByRole("tab", { name: "Overview" }).click();

			// Every Settings section: no stock memory backend rows (memory.backend, mnemopi, hindsight).
			const ids: string[] = [];
			let text = "";
			const sectionNames = await settings
				.locator("[data-settings-section]")
				.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-settings-section") ?? ""));
			for (const name of sectionNames) {
				await settings.locator(`[data-settings-section="${name}"]`).click();
				if (name === "memory") await expect(settings.locator("#setting-aiMemory")).toBeVisible();
				ids.push(...(await settings.locator("[id^='setting-']").evaluateAll(nodes => nodes.map(node => node.id))));
				text += `\n${await settings.innerText()}`;
			}
			expect(ids.filter(id => /^setting-(memory\.|mnemopi|hindsight)/i.test(id))).toEqual([]);
			expect(text).not.toMatch(/mnemopi|hindsight|memory\.backend/i);
			expect(ids).toContain("setting-aiMemory");
			await settings.locator('[data-settings-section="memory"]').click();
		});

		await test.step("Also use in the terminal omp runs ai-memory's own setup there; removing takes out only that", async () => {
			const settings = page.locator("[data-settings-page]");
			const row = settings.locator("#setting-aiMemory-terminal");
			await expect(row).toContainText("Terminal omp");
			await row.getByRole("button", { name: "Also use in the terminal omp", exact: true }).click();
			await expect(row.getByRole("button", { name: "Remove from the terminal omp", exact: true })).toBeVisible({
				timeout: 60_000,
			});
			// ai-memory's own `setup --agent omp`, this time into omp's real agent dir (no scratch redirect).
			expect(await commands(rig)).toEqual([PLAN, INIT, SETUP, ...GENERATORS, SETUP]);
			expect(existsSync(path.join(rig.agent, EXTENSION))).toBe(true);
			const mcp = JSON.parse(await fs.readFile(path.join(rig.agent, "mcp.json"), "utf8"));
			expect(Object.keys(mcp.mcpServers)).toEqual(["ai-memory"]);
			expect(await state(page)).toMatchObject({ phase: "ready", wiring: { app: true, terminal: true } });
			await expect(row.locator("[data-memory-terminal]")).toBeVisible();
			// The agent dir now loads the extension itself: a new session gets no second copy.
			expect((await newSessionArgv(page, rig)).join(" ")).not.toContain(rig.extRoot);

			await row.getByRole("button", { name: "Remove from the terminal omp", exact: true }).click();
			await expect(row.getByRole("button", { name: "Also use in the terminal omp", exact: true })).toBeVisible({
				timeout: 60_000,
			});
			expect(existsSync(path.join(rig.agent, EXTENSION))).toBe(false);
			// Only ai-memory's entry was there, so the file is gone with it; omp's own config would have stayed.
			expect(existsSync(path.join(rig.agent, "mcp.json"))).toBe(false);
			expect(await state(page)).toMatchObject({ wiring: { app: true, terminal: false } });
			expect((await newSessionArgv(page, rig)).join(" ")).toContain(`-e ${rig.extRoot}`);
			// No other agent's wiring was touched by either direction, and no uninstall ran.
			expect(await fs.readFile(rig.claude, "utf8")).toBe(CLAUDE_SETTINGS);
			expect((await commands(rig)).some(call => call.startsWith("uninstall"))).toBe(false);
		});

		await test.step("Delete all memory asks first, then stops the server, wipes wiki/db/raw itself and sets up again", async () => {
			const settings = page.locator("[data-settings-page]");
			for (const folder of ["wiki", "db", "raw"]) {
				await fs.mkdir(path.join(dataDir, folder), { recursive: true });
				await fs.writeFile(path.join(dataDir, folder, "page"), "remembered");
			}
			await settings.locator("#settings-memory").getByRole("tab", { name: "Maintenance" }).click();
			const del = settings
				.locator("#settings-memory")
				.getByRole("button", { name: "Delete all memory", exact: true });
			await del.click();
			const dialog = page.getByRole("dialog");
			await expect(dialog).toContainText("Delete all memory?");
			// The confirm stays off until the word is typed.
			await expect(dialog.locator("[data-memory-purge-confirm]")).toBeDisabled();
			await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
			await expect(dialog).toHaveCount(0);
			// Cancelled: nothing ran and nothing was deleted.
			expect(await commands(rig)).toEqual([PLAN, INIT, SETUP, ...GENERATORS, SETUP]);
			expect(existsSync(path.join(dataDir, "wiki", "page"))).toBe(true);

			const before = await serverPid(rig);
			await del.click();
			await dialog.locator("[data-memory-purge-input]").fill("delete");
			await dialog.locator("[data-memory-purge-confirm]").click();
			await expect(page.getByText("All memory deleted")).toBeVisible({ timeout: 60_000 });
			await settings.locator("#settings-memory").getByRole("tab", { name: "Overview" }).click();
			// The server came back through `setup` and the root was generated again; ai-memory's `uninstall` never ran.
			expect((await commands(rig)).slice(7)).toEqual([PLAN, SETUP, ...GENERATORS]);
			expect((await rig.memory.invocations()).join(" ")).not.toMatch(/uninstall|--purge-data/);
			for (const folder of ["wiki", "db", "raw"]) expect(existsSync(path.join(dataDir, folder))).toBe(false);
			// The config and token stay; the server runs again (a new process) and memory is on.
			expect(existsSync(path.join(dataDir, "config.toml"))).toBe(true);
			expect(existsSync(path.join(dataDir, "auth-tokens", "default"))).toBe(true);
			await phaseIs(page, "ready");
			expect(await serverPid(rig)).not.toBe(before);
			// Claude Code's wiring: still there, untouched.
			expect(await fs.readFile(rig.claude, "utf8")).toBe(CLAUDE_SETTINGS);
		});

		await test.step("the switch off stops loading the root and touches no other agent: no uninstall, Claude Code's wiring and its server stay", async () => {
			const settings = page.locator("[data-settings-page]");
			const pidBefore = await serverPid(rig);
			if (!pidBefore) throw new Error("no server pid");
			const callsBefore = (await commands(rig)).length;
			await settings.locator("#setting-aiMemory [role='switch']").click();
			await expect(settings.locator("#setting-aiMemory [role='switch']")).toHaveAttribute("aria-checked", "false");
			await phaseIs(page, "off");
			// Only a read-only listing of other clients ran; nothing applies an uninstall.
			expect((await commands(rig)).slice(callsBefore)).toEqual([LISTING]);
			// (The generators' own `--apply` writes into OMPdesk's root; an `uninstall` never carries it.)
			expect(
				(await rig.memory.invocations()).filter(call => call.startsWith("uninstall") && call.includes("--apply")),
			).toEqual([]);
			expect(await state(page)).toMatchObject({
				enabled: false,
				wiring: { app: false, terminal: false },
				stats: null,
			});
			expect(existsSync(rig.extRoot)).toBe(false);
			expect(existsSync(path.join(rig.agent, EXTENSION))).toBe(false);
			expect((await newSessionArgv(page, rig)).join(" ")).not.toContain("omp-ext");
			// Claude Code still uses ai-memory: its wiring and the server it talks to are untouched.
			expect(await fs.readFile(rig.claude, "utf8")).toBe(CLAUDE_SETTINGS);
			expect(isAlive(pidBefore)).toBe(true);
			expect(existsSync(path.join(dataDir, "config.toml"))).toBe(true);
			await expect(settings.locator("[data-memory-status]")).toContainText("Off");
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
			expect(await state(page)).toMatchObject({ enabled: false, wiring: { app: false, terminal: false } });
			const settings = await openSettings(page);
			await expect(settings.locator("#setting-aiMemory [role='switch']")).toHaveAttribute("aria-checked", "false");
			expect(await rig.memory.invocations()).toEqual(callsBefore);
		});

		await test.step("the switch on sets it up again; off with no other agent left stops the server", async () => {
			const settings = page.locator("[data-settings-page]");
			await settings.locator("#setting-aiMemory [role='switch']").click();
			await phaseIs(page, "ready");
			expect((await commands(rig)).slice(-5)).toEqual([PLAN, SETUP, ...GENERATORS]);
			expect(existsSync(path.join(rig.extRoot, "index.ts"))).toBe(true);
			expect((await newSessionArgv(page, rig)).join(" ")).toContain(`-e ${rig.extRoot}`);
			await expect(settings.locator("#setting-aiMemory [role='switch']")).toHaveAttribute("aria-checked", "true");
			await expect(settings.locator("[data-memory-status]")).toContainText("Running");
			await expect
				.poll(async () => JSON.parse(await fs.readFile(path.join(rig.desktop, "prefs.json"), "utf8")).aiMemory)
				.toBe(true);

			// With no other agent wired, off stops the server OMPdesk started.
			await fs.rm(path.dirname(rig.claude), { recursive: true, force: true });
			const pid = await serverPid(rig);
			if (!pid) throw new Error("no server pid");
			await settings.locator("#setting-aiMemory [role='switch']").click();
			await phaseIs(page, "off");
			await expect.poll(() => isAlive(pid)).toBe(false);
			expect(await serverPid(rig)).toBeNull();
			expect(existsSync(rig.extRoot)).toBe(false);
			expect(existsSync(path.join(dataDir, "config.toml"))).toBe(true);
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

test("ai-memory moves an earlier build's global omp wiring to the app-owned root, once, and keeps the rest", async () => {
	test.setTimeout(240_000);
	const rig = await makeRig();
	let current: Launched | null = null;
	try {
		// What the earlier build wrote: ai-memory's generated extension and MCP entry in omp's agent dir, running the
		// binary OMPdesk uses, beside a server and a setting of the user's own.
		await fs.mkdir(path.join(rig.agent, "extensions"), { recursive: true });
		await fs.writeFile(
			path.join(rig.agent, EXTENSION),
			"// Auto-generated by `ai-memory install-hooks --agent omp --apply`.\nexport default function () {}\n",
		);
		await fs.writeFile(
			path.join(rig.agent, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					other: { command: "other-server" },
					"ai-memory": { type: "stdio", command: rig.memory.bin, args: ["mcp-bridge"] },
				},
			}),
		);
		current = await launch(rig);
		const { page } = current;
		await phaseIs(page, "ready");
		expect(existsSync(path.join(rig.agent, EXTENSION))).toBe(false);
		expect(JSON.parse(await fs.readFile(path.join(rig.agent, "mcp.json"), "utf8"))).toEqual({
			mcpServers: { other: { command: "other-server" } },
		});
		expect(existsSync(path.join(rig.extRoot, "index.ts"))).toBe(true);
		expect(await state(page)).toMatchObject({ wiring: { app: true, terminal: false } });
		await expect
			.poll(async () => JSON.parse(await fs.readFile(path.join(rig.desktop, "prefs.json"), "utf8")).aiMemoryTerminal)
			.toBe(false);
		expect((await newSessionArgv(page, rig)).join(" ")).toContain(`-e ${rig.extRoot}`);
		expect(current.errors).toEqual([]);
	} finally {
		if (current) await exitApp(current.app);
		const pid = await serverPid(rig);
		if (pid && isAlive(pid)) process.kill(pid);
		await fs.rm(rig.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("an update-like relaunch whose service step is refused once comes back by itself, with the extension root current", async () => {
	test.setTimeout(240_000);
	const rig = await makeRig();
	let current: Launched | null = null;
	try {
		current = await launch(rig);
		await phaseIs(current.page, "ready");
		const generated = await fs.readFile(path.join(rig.extRoot, "index.ts"), "utf8");
		await exitApp(current.app);
		current = null;

		// v0.41.0's update: the root still holds an earlier build's extension, the old server is gone (setup booted it
		// out) and launchd refuses the first bootstrap of the new one ("5: Input/output error").
		await fs.writeFile(path.join(rig.extRoot, "index.ts"), `${generated}// an earlier build's extension\n`);
		const pid = await serverPid(rig);
		if (pid && isAlive(pid)) process.kill(pid);
		const refuse = path.join(rig.root, "refuse-service");
		await fs.writeFile(refuse, "");
		const setupsBefore = (await commands(rig)).filter(command => command === SETUP).length;

		current = await launch(rig, { FAKE_AI_MEMORY_REFUSE_SERVICE: refuse, OMP_GUI_RETRY_DELAYS_MS: "200" });
		const { page } = current;
		await phaseIs(page, "ready");
		expect(existsSync(refuse)).toBe(false);
		expect((await commands(rig)).filter(command => command === SETUP).length - setupsBefore).toBe(2);
		expect(await fs.readFile(path.join(rig.extRoot, "index.ts"), "utf8")).toBe(generated);
		const healthz = await fetch(`${(await state(page)).serverUrl}/healthz`);
		expect(healthz.ok).toBe(true);
		const log = (await fs.readFile(path.join(rig.desktop, "logs", "gui-runtime.jsonl"), "utf8"))
			.split("\n")
			.filter(line => line.includes('"source":"ai-memory"'));
		expect(log.some(line => line.includes('"message":"failed"') && line.includes("Bootstrap failed: 5"))).toBe(true);
		expect(log.some(line => line.includes('"message":"retry"'))).toBe(true);
		expect(current.errors).toEqual([]);
	} finally {
		if (current) await exitApp(current.app);
		const pid = await serverPid(rig);
		if (pid && isAlive(pid)) process.kill(pid);
		await fs.rm(rig.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
