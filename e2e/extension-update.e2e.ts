/**
 * The marketplaces, plugins and MCP servers of this computer's omp keep current, end to end, with the fake
 * installer (`OMP_GUI_TEST_INSTALLER`; `OMP_GUI_TEST_EXT_UPDATES=1` lets a test launch check on its own, like
 * the packaged app). The fixture omp's stock package carries stand-in modules at the specifiers the stock
 * helper's `extensions` worker imports (resources/gui-bridge/stock-helper/extensions.ts); their state lives in
 * `<root>/ext/state.json`, so a plugin upgrade changes what inventory and check report afterwards.
 *
 * - `demo@mkt` is installed at 1.0.0 while its catalog says 1.1.0: the marketplace is refreshed first, then the
 *   plugin goes Updating… (stock's upgrade is held) → "Updated 1.0.0 → 1.1.0.".
 * - `mcp-thing` is a stdio server whose command is a script in a fake global npm prefix on the login-shell PATH;
 *   the fake installer answers its check (1.1.0) and holds, then rewrites the package's version.
 * - `pinned-pkg` runs `npx -y pinned-pkg@1.0.0`: checked (1.2.0 exists), listed as available, never updated.
 * - The built-in REA is listed as part of the OMPdesk release.
 * After the pass the idle tab's omp is asked `extension_update.reload`, then `extension_update.reconnect` for
 * `mcp-thing` (the fixture omp answers the bridge and records each request). With the pref off nothing runs at
 * launch; Update now runs the same cycle for that row. Captures in en/ko.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

/**
 * `cli-mcp-<server> <method> check` prints the newest version; `update` of `mcp-thing` waits while the `hold`
 * file exists, then "installs" 1.1.0 by rewriting the package's version. Every call is logged.
 */
const INSTALLER = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dir = process.env.OMPDESK_FAKE_INSTALLER_DIR;
appendFileSync(join(dir, "installs.log"), args.join(" ") + "\\n");
if (args[0] === "cli-mcp-mcp-thing" && args[2] === "check") console.log("1.1.0");
if (args[0] === "cli-mcp-pinned-pkg" && args[2] === "check") console.log("1.2.0");
if (args[0] === "cli-mcp-mcp-thing" && args[2] === "update") {
	while (existsSync(join(dir, "hold"))) await Bun.sleep(25);
	const file = process.env.OMPDESK_FAKE_MCP_PACKAGE;
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version: "1.1.0" }));
	console.log("Updated mcp-thing to 1.1.0");
}
`;

/** The stand-in modules' shared source: every stock specifier the worker imports maps to this one file. */
const STOCK_STAND_IN = (ext: string, agent: string) => `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const DIR = ${JSON.stringify(ext)};
const AGENT = ${JSON.stringify(agent)};
const read = () => JSON.parse(readFileSync(DIR + "/state.json", "utf8"));
const write = state => writeFileSync(DIR + "/state.json", JSON.stringify(state));
const log = (...entry) => appendFileSync(DIR + "/calls.log", JSON.stringify(entry) + "\\n");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const getInstalledPluginsRegistryPath = () => DIR + "/installed_plugins.json";
export const getMarketplacesCacheDir = () => DIR + "/marketplaces";
export const getMarketplacesRegistryPath = () => DIR + "/marketplaces.json";
export const getPluginsCacheDir = () => DIR + "/plugins-cache";
export class MarketplaceManager {
	async listMarketplaces() {
		const state = read();
		return [{ name: "mkt", sourceUri: state.marketplaceSource, updatedAt: state.refreshedAt }];
	}
	async updateMarketplace(name) {
		log("updateMarketplace", name);
		const state = read();
		state.refreshedAt = new Date().toISOString();
		write(state);
		return { name, updatedAt: state.refreshedAt };
	}
	async listInstalledPlugins() {
		return [{ id: "demo@mkt", scope: "user", entries: [{ version: read().installed, enabled: true }] }];
	}
	async checkForUpdates() {
		log("checkForUpdates");
		const state = read();
		return state.installed === state.catalog ? [] : [{ pluginId: "demo@mkt", scope: "user", from: state.installed, to: state.catalog }];
	}
	async upgradePlugin(id, scope) {
		log("upgradePlugin", id, scope);
		while (existsSync(DIR + "/plugin-hold")) await sleep(25);
		const state = read();
		state.installed = state.catalog;
		write(state);
		return { version: state.installed };
	}
}
export const clearPluginRootsAndCaches = () => {};
export const resolveActiveProjectRegistryPath = async () => null;
export class PluginManager {
	async list() { return []; }
}
export const parseGitUrl = () => null;
export const getEnabledPlugins = async () => [
	{ name: "demo", path: DIR + "/plugins/demo", version: read().installed, enabledFeatures: null, manifest: {} },
];
export const resolvePluginManifestEntries = () => [];
export const loadNpmRegistryResolver = async () => () => ({ url: "http://127.0.0.1:9/" });
export const npmRegistryPackageUrl = (registry, pkg) => registry.url + pkg;
export const Settings = { loadReadOnly: async () => ({ extensionsSourceLevel: () => "user" }) };
export const cfgSkills = { get: () => ({}) };
export const cfgDisabledExtensions = { get: () => [] };
export const cfgExtensions = { get: () => [] };
export const loadSkills = async () => ({ skills: [], warnings: [] });
export const initializeWithSettings = () => () => {};
export const loadCapability = async (id, options) => ({
	items: read().mcpItems.map(item => ({ ...item, _source: { provider: "mcp-json", path: AGENT + "/mcp.json", level: "user" } })).filter(item => !options.filter || options.filter(item)),
});
export const loadAllMCPConfigs = async () => ({ configs: Object.fromEntries(read().mcpItems.map(item => [item.name, { type: "stdio" }])) });
export const SkillshareClient = { create: async () => ({ packument: async () => ({ distTags: {} }), close() {} }) };
export const listInstalledSkills = async () => [];
export const resolveSkillVersion = () => ({ version: "0.0.0" });
export const updateSkillPackages = async () => [];
export const getProjectSkillsInstallPaths = async () => { throw new Error("not a project"); };
`;

/** The `specifier → file` exports the worker's `load()` resolves against the fixture's stock package. */
const STOCK_SPECIFIERS = [
	"extensibility/plugins/marketplace",
	"discovery/helpers",
	"extensibility/plugins/manager",
	"extensibility/plugins/git-url",
	"extensibility/plugins/loader",
	"cli/npm-registry",
	"config/settings",
	"extensibility/settings",
	"extensibility/skills",
	"discovery",
	"mcp/config",
	"skillshare/client",
	"skillshare/installer",
	"skillshare/manifest",
];

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
	record: string;
	errors: string[];
}

const NPM_PACKAGE = ["lib", "node_modules", "mcp-thing"] as const;
const TOOL_NAMES = ["mcp-thing", "claude", "codex", "gemini", "cursor-agent", "copilot", "gh", "node"];

/** The test's PATH without any directory that holds one of the tools, so the developer's own never answers. */
function cleanPath(extra: string): string {
	const rest = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(dir => dir && !TOOL_NAMES.some(name => existsSync(path.join(dir, name))));
	return [extra, ...rest].join(path.delimiter);
}

async function launch(name: string, prefs: Record<string, unknown>, held: boolean): Promise<Launched> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-ext-update-${name}-`)));
	const home = path.join(root, "home");
	const desktop = path.join(root, "desktop");
	const project = path.join(root, "project");
	const agent = path.join(root, "agent");
	const installerDir = path.join(root, "installer");
	const ext = path.join(root, "ext");
	const npmPrefix = path.join(root, "npm");
	await Promise.all(
		[home, desktop, project, agent, installerDir, ext, path.join(npmPrefix, "bin")].map(dir =>
			fs.mkdir(dir, { recursive: true }),
		),
	);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ firstRunComplete: true, themeName: "light", ...prefs }),
	);
	// Machine setup's optional gh and Node have nothing to install here: keep the launch quiet.
	const missed = { failures: 3, lastAttempt: Date.now() };
	await fs.writeFile(path.join(desktop, "setup-state.json"), JSON.stringify({ gh: missed, node: missed }));

	// `mcp-thing`: a script in a global npm package, linked from the prefix's bin dir like `npm i -g` does.
	const pkgDir = path.join(npmPrefix, ...NPM_PACKAGE);
	await fs.mkdir(pkgDir, { recursive: true });
	const packageFile = path.join(pkgDir, "package.json");
	await fs.writeFile(
		packageFile,
		JSON.stringify({ name: "mcp-thing", version: "1.0.0", bin: { "mcp-thing": "cli.js" } }),
	);
	await fs.writeFile(path.join(pkgDir, "cli.js"), "#!/usr/bin/env node\nconsole.log('mcp-thing');\n", { mode: 0o755 });
	await fs.symlink(path.join("..", ...NPM_PACKAGE, "cli.js"), path.join(npmPrefix, "bin", "mcp-thing"));

	// The stand-in stock state: demo@mkt installed at 1.0.0, its catalog at 1.1.0, two configured servers.
	await fs.writeFile(
		path.join(ext, "state.json"),
		JSON.stringify({
			marketplaceSource: path.join(root, "marketplace"),
			refreshedAt: "2026-01-01T00:00:00.000Z",
			installed: "1.0.0",
			catalog: "1.1.0",
			mcpItems: [
				{ name: "mcp-thing", command: "mcp-thing", args: [] },
				{ name: "pinned-pkg", command: "npx", args: ["-y", "pinned-pkg@1.0.0"] },
			],
		}),
	);

	const omp = await fixtureOmp(root);
	const stock = path.join(path.dirname(omp), "node_modules", "@oh-my-pi", "pi-coding-agent");
	const manifest: { exports: Record<string, string> } = JSON.parse(
		await fs.readFile(path.join(stock, "package.json"), "utf8"),
	);
	for (const specifier of STOCK_SPECIFIERS) manifest.exports[`./${specifier}`] = "./extensions-stand-in.ts";
	await fs.writeFile(path.join(stock, "package.json"), JSON.stringify(manifest));
	await fs.writeFile(path.join(stock, "extensions-stand-in.ts"), STOCK_STAND_IN(ext, agent));
	const utils = path.join(path.dirname(stock), "pi-utils");
	await fs.mkdir(utils, { recursive: true });
	await fs.writeFile(
		path.join(utils, "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-utils", type: "module", exports: { ".": "./index.ts" } }),
	);
	await fs.writeFile(
		path.join(utils, "index.ts"),
		`export const getPluginsPackageJson = () => ${JSON.stringify(path.join(ext, "plugins-package.json"))};
export const getMCPConfigPath = () => ${JSON.stringify(path.join(agent, "mcp.json"))};
`,
	);

	const PATH = cleanPath(path.join(npmPrefix, "bin"));
	// The login-shell probe would add Homebrew's dirs (path_helper); this one reports PATH as it is.
	const shell = path.join(root, "login-shell");
	await fs.writeFile(shell, `#!/bin/sh\nexec /usr/bin/env PATH='${PATH}' /bin/sh -c "$2"\n`, { mode: 0o755 });
	const installer = await writeFakeOmp(installerDir, INSTALLER);
	if (held) {
		await fs.writeFile(path.join(installerDir, "hold"), "");
		await fs.writeFile(path.join(ext, "plugin-hold"), "");
	}
	const record = path.join(root, "rpc.jsonl");
	const env = {
		...process.env,
		PATH,
		SHELL: shell,
		HOME: home,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: "omp-config",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: omp,
		OMP_GUI_TEST_RECORD: record,
		OMP_GUI_TEST_INSTALLER: installer,
		OMP_GUI_TEST_EXT_UPDATES: "1",
		OMP_GUI_TEST_BREW_DIRS: "",
		OMPDESK_FAKE_INSTALLER_DIR: installerDir,
		OMPDESK_FAKE_MCP_PACKAGE: packageFile,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page, root, record, errors };
}

async function close(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** `cli-mcp-…` installer calls, in order. */
async function installs(launched: Launched): Promise<string[]> {
	const log = await fs.readFile(path.join(launched.root, "installer", "installs.log"), "utf8").catch(() => "");
	return log.split("\n").filter(line => line.startsWith("cli-"));
}

/** The stand-in stock's calls, as `[method, ...args]`. */
async function stockCalls(launched: Launched): Promise<string[][]> {
	const log = await fs.readFile(path.join(launched.root, "ext", "calls.log"), "utf8").catch(() => "");
	return log
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as string[]);
}

/** Bridge requests the fixture omp received for the extension update, in order. */
async function bridgeRequests(launched: Launched): Promise<Array<{ type: string; names?: string[] }>> {
	const text = await fs.readFile(launched.record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { type: string; names?: string[] })
		.filter(frame => frame.type.startsWith("extension_update."));
}

const releasePlugin = (launched: Launched) => fs.rm(path.join(launched.root, "ext", "plugin-hold"), { force: true });
const releaseInstaller = (launched: Launched) => fs.rm(path.join(launched.root, "installer", "hold"), { force: true });

const waitForReadyTab = (page: Page) =>
	expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 30_000 })
		.toBe("ready");

async function openExtensions(page: Page) {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="updates"]').click();
	await expect(settings.getByTestId("extension-update-group")).toBeVisible();
	return settings;
}

/** `extensionDomId` of a row key, as the row's test ids and anchors spell it. */
const PLUGIN = "plugin-demo-mkt-user";
const MARKETPLACE = "marketplace-mkt";
const MCP = "mcp-mcp-thing";
const PINNED = "mcp-pinned-pkg";
const BUILTIN = "mcp-rea";

const status = (settings: Locator, id: string) => settings.getByTestId(`extension-status-${id}`);

test.skip(process.platform === "win32", "the fake npm package's bin is a symlink to a shebang script");

for (const language of ["en", "ko"] as const) {
	const strings: Record<string, string> = language === "en" ? en : ko;
	const tr = (key: string, params: Record<string, string> = {}) =>
		Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), strings[key] ?? key);

	test(`marketplaces, plugins and MCP servers keep current: refresh, plugin upgrade, MCP update, reload and reconnect (${language})`, async () => {
		test.setTimeout(150_000);
		const launched = await launch(`auto-${language}`, { language }, true);
		const { page } = launched;
		const shot = async (name: string) => {
			await page.getByTestId("extension-update-group").evaluate(row => row.scrollIntoView({ block: "start" }));
			await page.mouse.move(1, 1);
			await page.locator("[data-settings-page]").screenshot({
				animations: "disabled",
				path: test.info().outputPath(`extension-update-${language}-${name}.png`),
			});
		};
		try {
			await waitForReadyTab(page);
			const settings = await openExtensions(page);
			await expect(settings.locator("#setting-gui-extensionAutoUpdate [role='switch']")).toHaveAttribute(
				"aria-checked",
				"true",
			);
			// Everything installed is listed: the marketplace, the plugin, both servers and the built-in REA.
			await expect(settings.locator("[data-extension-row]")).toHaveCount(5, { timeout: 30_000 });
			await expect(settings.getByTestId(`extension-meta-${MARKETPLACE}`)).toContainText(
				tr("extensionUpdate.kind.marketplace"),
			);
			await expect(settings.locator(`#setting-extension-${MCP}`)).toContainText(
				tr("extensionUpdate.method", { method: "npm" }),
			);

			// Nobody clicked: the catalog is refreshed first, then the plugin's upgrade runs (held by stock's stand-in).
			await expect(status(settings, MARKETPLACE)).toHaveText(tr("extensionUpdate.status.refreshed"), {
				timeout: 60_000,
			});
			await expect(status(settings, PLUGIN)).toHaveText(tr("extensionUpdate.status.updating"), { timeout: 60_000 });
			await expect(settings.getByTestId(`extension-version-${PLUGIN}`)).toHaveText(
				`${tr("extensionUpdate.version.installed", { version: "1.0.0" })} · ${tr("extensionUpdate.version.latest", { version: "1.1.0" })}`,
			);
			await expect(settings.getByTestId(`extension-update-now-${PLUGIN}`)).toBeDisabled();
			await expect(settings.locator(`#setting-extension-${PLUGIN}`)).toContainText(
				tr("extensionUpdate.method", { method: tr("extensionUpdate.method.marketplace") }),
			);
			await shot("1-updating");

			await releasePlugin(launched);
			await expect(status(settings, PLUGIN)).toHaveText(
				tr("extensionUpdate.status.updatedFrom", { from: "1.0.0", to: "1.1.0" }),
				{ timeout: 30_000 },
			);
			await expect(settings.getByTestId(`extension-version-${PLUGIN}`)).toHaveText(
				`${tr("extensionUpdate.version.installed", { version: "1.1.0" })} · ${tr("extensionUpdate.version.latest", { version: "1.1.0" })}`,
			);

			// The MCP server's package: checked through the installer, updated by its owner (npm), held meanwhile.
			await expect(status(settings, MCP)).toHaveText(tr("extensionUpdate.status.updating"), { timeout: 30_000 });
			await expect(settings.getByTestId(`extension-version-${MCP}`)).toHaveText(
				`${tr("extensionUpdate.version.installed", { version: "1.0.0" })} · ${tr("extensionUpdate.version.latest", { version: "1.1.0" })}`,
			);
			await expect(settings.getByTestId(`extension-update-now-${MCP}`)).toBeDisabled();
			await expect
				.poll(() => installs(launched), { timeout: 30_000 })
				.toEqual(["cli-mcp-mcp-thing npm check", "cli-mcp-mcp-thing npm update"]);

			await releaseInstaller(launched);
			await expect(status(settings, MCP)).toHaveText(
				tr("extensionUpdate.status.updatedFrom", { from: "1.0.0", to: "1.1.0" }),
				{ timeout: 30_000 },
			);
			await expect(settings.getByTestId(`extension-version-${MCP}`)).toHaveText(
				`${tr("extensionUpdate.version.installed", { version: "1.1.0" })} · ${tr("extensionUpdate.version.latest", { version: "1.1.0" })}`,
			);
			const pkg = JSON.parse(
				await fs.readFile(path.join(launched.root, "npm", ...NPM_PACKAGE, "package.json"), "utf8"),
			);
			expect(pkg.version).toBe("1.1.0");

			// The pinned runner package: a newer version is shown, the button is off, nothing is ever updated.
			await expect(status(settings, PINNED)).toHaveText(
				tr("extensionUpdate.status.available", { installed: "1.0.0", latest: "1.2.0" }),
				{ timeout: 30_000 },
			);
			await expect(settings.getByTestId(`extension-update-now-${PINNED}`)).toBeDisabled();
			// The built-in REA belongs to this OMPdesk release.
			await expect(status(settings, BUILTIN)).toHaveText(tr("extensionUpdate.skip.builtin"));
			await expect(settings.getByTestId(`extension-update-now-${BUILTIN}`)).toBeDisabled();

			// The idle tab's omp is told once the pass is over: plugin state reloaded, then the updated server reconnected.
			await expect
				.poll(() => bridgeRequests(launched), { timeout: 30_000 })
				.toEqual([
					{ type: "extension_update.reload", recordedBy: expect.any(String) },
					{ type: "extension_update.reconnect", names: ["mcp-thing"], recordedBy: expect.any(String) },
				]);
			await shot("2-updated");

			expect(await installs(launched)).toEqual([
				"cli-mcp-mcp-thing npm check",
				"cli-mcp-mcp-thing npm update",
				"cli-mcp-pinned-pkg npm check",
			]);
			const calls = (await stockCalls(launched)).map(call => call[0]);
			expect(calls.filter(call => call === "updateMarketplace")).toEqual(["updateMarketplace"]);
			expect(calls.filter(call => call === "upgradePlugin")).toEqual(["upgradePlugin"]);
			expect(launched.errors).toEqual([]);
		} finally {
			await close(launched);
		}
	});
}

test("with the pref off nothing runs at launch; Update now runs that row's cycle and tells the tab", async () => {
	test.setTimeout(120_000);
	const launched = await launch("off", { language: "en", extensionAutoUpdate: false }, false);
	const { page } = launched;
	try {
		await waitForReadyTab(page);
		const settings = await openExtensions(page);
		await expect(settings.locator("#setting-gui-extensionAutoUpdate [role='switch']")).toHaveAttribute(
			"aria-checked",
			"false",
		);
		await expect(settings.locator("[data-extension-row]")).toHaveCount(5, { timeout: 30_000 });
		for (const id of [MARKETPLACE, PLUGIN, MCP]) {
			await expect(status(settings, id)).toHaveText("Not checked yet.");
		}
		await expect(settings.getByTestId(`extension-version-${PLUGIN}`)).toHaveText("Installed 1.0.0");
		await expect(settings.getByTestId(`extension-version-${MCP}`)).toHaveText("Installed 1.0.0");
		expect(await installs(launched)).toEqual([]);
		const names = (await stockCalls(launched)).map(call => call[0]);
		expect(names).not.toContain("updateMarketplace");
		expect(names).not.toContain("upgradePlugin");
		expect(await bridgeRequests(launched)).toEqual([]);

		await settings.getByTestId(`extension-update-now-${PLUGIN}`).click();
		await expect(status(settings, PLUGIN)).toHaveText("Updated 1.0.0 → 1.1.0.", { timeout: 30_000 });
		await expect
			.poll(async () => (await bridgeRequests(launched)).map(frame => frame.type))
			.toEqual(["extension_update.reload"]);
		// Only that row ran: the marketplace and the servers were left alone.
		expect((await stockCalls(launched)).map(call => call[0]).filter(call => call === "updateMarketplace")).toEqual(
			[],
		);
		expect(await installs(launched)).toEqual([]);
		await expect(status(settings, MCP)).toHaveText("Not checked yet.");

		await settings.getByTestId(`extension-update-now-${MCP}`).click();
		await expect(status(settings, MCP)).toHaveText("Updated 1.0.0 → 1.1.0.", { timeout: 30_000 });
		expect(await installs(launched)).toEqual(["cli-mcp-mcp-thing npm check", "cli-mcp-mcp-thing npm update"]);
		await expect
			.poll(() => bridgeRequests(launched))
			.toEqual([
				{ type: "extension_update.reload", recordedBy: expect.any(String) },
				{ type: "extension_update.reconnect", names: ["mcp-thing"], recordedBy: expect.any(String) },
			]);

		// The switch writes the pref main reads.
		await settings.locator("#setting-gui-extensionAutoUpdate [role='switch']").click();
		await expect(settings.locator("#setting-gui-extensionAutoUpdate [role='switch']")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(await page.evaluate(() => window.omp.prefs.get("extensionAutoUpdate"))).toBe(true);
		expect(launched.errors).toEqual([]);
	} finally {
		await close(launched);
	}
});
