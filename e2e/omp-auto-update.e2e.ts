/**
 * omp updates itself, end to end, with a fake registry and a fake installer
 * (`OMP_GUI_TEST_NPM_REGISTRY`, `OMP_GUI_TEST_INSTALLER`; both are needed for a
 * test launch to check at all). The registry's latest (18.12.0) is newer than
 * the fixture omp (18.11.0), so main runs the omp-update plan on its own while
 * the tab keeps its process and its draft; once the installer reports the new
 * version, main re-detects omp, restarts the idle tab on it (the boot log shows
 * 18.11.0 then 18.12.0), shows one "omp updated to 18.12.0" toast, and the
 * restarted bridge's capabilities probe names a feature the new omp lacks.
 * With the pref off nothing checks on its own, and "Update now" still works.
 */
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

/** The fake installer: logs each call; the omp update waits for the test's `go` file, then "installs" 18.12.0. */
const INSTALLER = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [item, method] = process.argv.slice(2);
const dir = process.env.OMPDESK_FAKE_INSTALLER_DIR;
appendFileSync(join(dir, "installs.log"), item + " " + method + "\\n");
if (item === "omp" && method === "omp-update") {
	console.log("Current version: 18.11.0\\nNew version available: 18.12.0");
	while (!existsSync(join(dir, "go"))) await Bun.sleep(25);
	writeFileSync(process.env.OMPDESK_FAKE_VERSION_FILE, "18.12.0");
	console.log("Updated to 18.12.0");
} else {
	console.log("fake " + item + " install");
}
`;

const DRAFT = "a draft that must survive the omp restart";

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
	errors: string[];
	registry: Server;
	/** How many times main asked the registry for the latest omp. */
	registryRequests: () => number;
}

async function registryServer(): Promise<{ server: Server; url: string; requests: () => number }> {
	let requests = 0;
	const server = createServer((request, response) => {
		if (request.url === "/-/package/@oh-my-pi/pi-coding-agent/dist-tags") {
			requests += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ latest: "18.12.0" }));
			return;
		}
		response.writeHead(404).end();
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return { server, url: `http://127.0.0.1:${port}`, requests: () => requests };
}

async function launch(name: string, prefs: Record<string, unknown>): Promise<Launched> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-update-${name}-`));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const installerDir = path.join(root, "installer");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(installerDir)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ firstRunComplete: true, language: "en", ...prefs }),
	);
	const omp = await fixtureOmp(root);
	const installer = await writeFakeOmp(installerDir, INSTALLER);
	const registry = await registryServer();
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: omp,
		OMP_GUI_TEST_INSTALLER: installer,
		OMP_GUI_TEST_NPM_REGISTRY: registry.url,
		OMP_GUI_TEST_VERSION_FILE: path.join(root, "omp-version"),
		OMP_GUI_TEST_BOOT_LOG: path.join(root, "boots.log"),
		OMP_GUI_TEST_UNAVAILABLE_AFTER_UPDATE: "planMode",
		OMPDESK_FAKE_INSTALLER_DIR: installerDir,
		OMPDESK_FAKE_VERSION_FILE: path.join(root, "omp-version"),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page, root, errors, registry: registry.server, registryRequests: registry.requests };
}

async function close(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	launched.registry.close();
	await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const sidecarStatus = (page: Page) => page.evaluate(async () => (await window.omp.sidecar.getStatus()).status);
const updatePhase = (page: Page) => page.evaluate(async () => (await window.omp.ompUpdate.getState()).phase);

async function boots(launched: Launched): Promise<string[]> {
	const log = await fs.readFile(path.join(launched.root, "boots.log"), "utf8").catch(() => "");
	return log.split("\n").filter(Boolean);
}

async function installs(launched: Launched): Promise<string[]> {
	const log = await fs.readFile(path.join(launched.root, "installer", "installs.log"), "utf8").catch(() => "");
	return log.split("\n").filter(line => line.startsWith("omp "));
}

async function releaseInstaller(launched: Launched): Promise<void> {
	await fs.writeFile(path.join(launched.root, "installer", "go"), "");
}

/** After "go": one toast, the idle tab restarted on 18.12.0, its draft kept, the probe's warning, the state in Settings. */
async function expectUpdated(launched: Launched): Promise<void> {
	const { page } = launched;
	await expect(page.getByText("omp updated to 18.12.0")).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => boots(launched), { timeout: 30_000 }).toEqual(["18.11.0", "18.12.0"]);
	await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
	await expect(page.locator(".omp-composer-input").first()).toHaveValue(DRAFT);
	// The restarted bridge answered the capabilities probe for 18.12.0; planMode is missing there.
	await expect(page.getByText(/missing internals OMPdesk needs for: Plan mode/)).toBeVisible({ timeout: 30_000 });
	expect(await installs(launched)).toEqual(["omp omp-update"]);
	const state = await page.evaluate(() => window.omp.ompUpdate.getState());
	expect(state).toMatchObject({
		phase: "idle",
		installed: "18.12.0",
		latest: "18.12.0",
		updatedTo: "18.12.0",
		failure: null,
	});
	expect(launched.errors).toEqual([]);
}

test("a newer omp installs on its own; the idle tab restarts on it with its draft, and the probe runs again", async () => {
	test.setTimeout(120_000);
	const launched = await launch("auto", {});
	try {
		const { page } = launched;
		await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
		await page.locator(".omp-composer-input").first().fill(DRAFT);
		// Nobody clicked: main found 18.12.0 > 18.11.0 and runs the installer, which waits for `go`.
		await expect.poll(() => updatePhase(page), { timeout: 30_000 }).toBe("updating");
		await expect.poll(() => installs(launched), { timeout: 30_000 }).toEqual(["omp omp-update"]);
		// The install never touches the running tab: same process, still ready.
		expect(await boots(launched)).toEqual(["18.11.0"]);
		expect(await sidecarStatus(page)).toBe("ready");
		await releaseInstaller(launched);
		await expectUpdated(launched);
		// Settings › Updates & about › This computer: the switch is on and the status says so.
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="updates"]').click();
		await expect(settings.locator("#setting-gui-ompAutoUpdate [role='switch']")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(settings.getByTestId("omp-update-status")).toHaveText("omp 18.12.0 is the latest.");
	} finally {
		await close(launched);
	}
});

test("with the pref off nothing checks on its own; Update now still updates", async () => {
	test.setTimeout(120_000);
	const launched = await launch("off", { ompAutoUpdate: false });
	try {
		const { page } = launched;
		await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
		await page.locator(".omp-composer-input").first().fill(DRAFT);
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="updates"]').click();
		await expect(settings.locator("#setting-gui-ompAutoUpdate [role='switch']")).toHaveAttribute(
			"aria-checked",
			"false",
		);
		expect(launched.registryRequests()).toBe(0);
		expect(await installs(launched)).toEqual([]);
		await settings.getByTestId("omp-update-now").click();
		await expect.poll(() => installs(launched), { timeout: 30_000 }).toEqual(["omp omp-update"]);
		await releaseInstaller(launched);
		await expect(page.getByText("omp updated to 18.12.0")).toBeVisible({ timeout: 30_000 });
		expect(launched.registryRequests()).toBe(1);
		await expect.poll(() => boots(launched), { timeout: 30_000 }).toEqual(["18.11.0", "18.12.0"]);
		await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
	} finally {
		await close(launched);
	}
});

/** Opt-in captures (`OMP_GUI_OMP_UPDATE_CAPTURES=<dir>`): the updating row, the updated toast and Settings' omp rows. */
const CAPTURES = process.env.OMP_GUI_OMP_UPDATE_CAPTURES ?? "";
for (const [language, themeName] of [
	["en", "light"],
	["ko", "dark"],
] as const)
	test(`omp update captures (${language} ${themeName})`, async () => {
		test.skip(!CAPTURES, "OMP_GUI_OMP_UPDATE_CAPTURES=<dir> captures the update surfaces");
		test.setTimeout(120_000);
		await fs.mkdir(CAPTURES, { recursive: true });
		const launched = await launch(`capture-${language}`, { language, themeName });
		try {
			const { page } = launched;
			const shot = async (name: string) => {
				await page.mouse.move(1, 1);
				await page.screenshot({
					path: path.join(CAPTURES, `${language}-${themeName}-${name}.png`),
					scale: "css",
					animations: "disabled",
				});
			};
			await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
			await expect.poll(() => updatePhase(page), { timeout: 30_000 }).toBe("updating");
			const settings = page.locator("[data-settings-page]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
			await settings.locator('[data-settings-section="updates"]').click();
			await expect(settings.getByTestId("omp-update-status")).toBeVisible();
			await shot("1-updating-settings");
			await page.keyboard.press("Escape");
			await releaseInstaller(launched);
			await expect.poll(() => boots(launched), { timeout: 30_000 }).toEqual(["18.11.0", "18.12.0"]);
			await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
			await expect(page.locator("[role='status'], [role='alert']").first()).toBeVisible({ timeout: 30_000 });
			await shot("2-updated-toast");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
			await settings.locator('[data-settings-section="updates"]').click();
			await expect(settings.getByTestId("omp-update-status")).toBeVisible();
			await shot("3-updated-settings");
		} finally {
			await close(launched);
		}
	});
