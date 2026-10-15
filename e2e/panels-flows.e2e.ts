import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";
import { capturer, type Finding, resize } from "./shell-capture";

// Opt-in flow audit of the right panel, Settings, Stats and Agents
// (OMP_GUI_PANELS_FLOWS=<dir>), on the fake omp: remote pairing between two
// apps through a host restart and an unpair, the provider and account flows
// (add an account, an API-key sign-in, remove, rotation mode, the custom
// endpoint form) with a relaunch, a remapped shortcut that survives a relaunch
// and fires, and a walk through every settings section, the stats and agents
// pages and every panel view in English/light and Korean/dark. Each capture
// records overflow, clipping and motion findings next to it.

const directory = process.env.OMP_GUI_PANELS_FLOWS;
test.describe.configure({ mode: "parallel" });
test.skip(!directory, "set OMP_GUI_PANELS_FLOWS=<dir> to capture the panel and settings flows");

type Language = "en" | "ko";

interface Instance {
	app: ElectronApplication;
	page: Page;
	root: string;
	project: string;
	errors: string[];
}

interface LaunchOptions {
	language?: Language;
	theme?: string;
	env?: Record<string, string>;
	/** Extra prefs merged into the first launch's prefs.json (a relaunch keeps the file). */
	prefs?: Record<string, unknown>;
	/** Leave out the stock natives, so the terminal's PTY cannot start. */
	withoutNatives?: boolean;
}

/** The fake omp with the stock natives beside it, so the terminal's PTY runs (as in panel-views). */
async function fixtureOmpWithNatives(root: string): Promise<string> {
	const bin = await fixtureOmp(root);
	const natives =
		process.env.OMP_GUI_TEST_NATIVES ||
		path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
	const link = path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives");
	if (!(await fs.lstat(link).catch(() => null))) await fs.symlink(natives, link, "dir");
	return bin;
}

/** Launch on `root`; a second call on the same root is a relaunch of the same profile. */
async function launch(root: string, options: LaunchOptions = {}): Promise<Instance> {
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir, { recursive: true })));
	const prefsFile = path.join(desktop, "prefs.json");
	if (!(await fs.stat(prefsFile).catch(() => null)))
		await fs.writeFile(
			prefsFile,
			JSON.stringify({
				language: options.language ?? "en",
				themeName: options.theme ?? "light",
				firstRunComplete: true,
				...options.prefs,
			}),
		);
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: options.withoutNatives ? await fixtureOmp(root) : await fixtureOmpWithNatives(root),
		OMP_GUI_REMOTE_PORT: "0",
		...options.env,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await resize(app, 1440, 900);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page, root, project: await fs.realpath(project), errors };
}

interface Recorder {
	shoot: (name: string) => Promise<void>;
	notes: string[];
	finish: (errors: string[]) => Promise<void>;
}

function recorder(page: Page, prefix: string): Recorder {
	const findings: Finding[] = [];
	const notes: string[] = [];
	return {
		shoot: capturer(page, directory, prefix, findings),
		notes,
		finish: async errors => {
			if (!directory) return;
			await fs.writeFile(
				path.join(directory, `${prefix}-findings.json`),
				JSON.stringify({ findings, notes, errors }, null, 2),
			);
		},
	};
}

async function openSettings(page: Page, section: string): Promise<Locator> {
	const settings = page.locator("[data-settings-page]");
	if (!(await settings.isVisible())) await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator(`[data-settings-section="${section}"]`).click();
	return settings;
}

async function closeSettings(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-settings-page]")).toHaveCount(0);
}

async function tempRoot(name: string): Promise<string> {
	return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-panels-flows-${name}-`)));
}

async function cleanup(root: string): Promise<void> {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ── Remote pairing between two apps, through a host restart and an unpair ──
test("remote pairing flow", async () => {
	test.setTimeout(300_000);
	const root = await tempRoot("remote");
	const discovery = 49_000 + Math.floor(Math.random() * 1_000) * 2;
	const hostRoot = path.join(root, "b");
	const clientRoot = path.join(root, "a");
	const hostEnv = (port: string) => ({
		OMP_GUI_REMOTE_PORT: port,
		OMP_GUI_REMOTE_DISCOVERY_PORT: String(discovery),
	});
	let host: Instance | null = await launch(hostRoot, { env: hostEnv("0") });
	let client: Instance | null = await launch(clientRoot, {
		env: { OMP_GUI_REMOTE_DISCOVERY_PORT: String(discovery + 1) },
	});
	const b = recorder(host.page, "remote-host");
	const a = recorder(client.page, "remote-client");
	try {
		// B: share this computer, rename it, read its address and code.
		await openSettings(host.page, "connections");
		await b.shoot("off");
		await host.page.getByRole("switch", { name: "Let other devices use this computer" }).click();
		const codeRow = host.page.locator("[data-remote-section] [data-remote-code]");
		await expect(codeRow).toContainText(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
		const name = host.page.getByLabel("Device name", { exact: true });
		await name.fill("Studio Mac mini");
		await name.press("Enter");
		await expect
			.poll(() => host?.page.evaluate(async () => (await window.omp.remote.getState()).host.name))
			.toBe("Studio Mac mini");
		await b.shoot("sharing");
		const port = /:(\d+)/.exec(
			(await host.page.locator("[data-remote-addresses] li").first().textContent()) ?? "",
		)?.[1];
		if (!port) throw new Error("expected the host's port");

		// A: connect with a wrong code, then the right one.
		await openSettings(client.page, "connections");
		await a.shoot("empty");
		await client.page.locator("[data-remote-connect]").click();
		const dialog = client.page.getByRole("dialog", { name: "Connect to a device" });
		await expect(dialog).toBeVisible();
		await a.shoot("connect-dialog");
		await dialog.locator("input[data-remote-address]").fill(`127.0.0.1:${port}`);
		await dialog.locator("input[data-remote-code]").fill("ZZZZ-ZZZZ");
		await dialog.locator("[data-remote-connect-submit]").click();
		await expect(dialog.locator("[data-remote-connect-error]")).toBeVisible();
		await a.shoot("wrong-code");
		const code = /[0-9A-Z]{4}-[0-9A-Z]{4}/.exec((await codeRow.textContent()) ?? "")?.[0] ?? "";
		await dialog.locator("input[data-remote-code]").fill(code);
		await dialog.locator("[data-remote-connect-submit]").click();
		await expect(dialog).toHaveCount(0);
		const hostRow = client.page.locator("[data-remote-hosts] [data-remote-host]");
		await expect(hostRow).toContainText("Online");
		await expect(hostRow).toContainText("Studio Mac mini");
		await a.shoot("paired");
		const deviceId = (await hostRow.getAttribute("data-remote-host")) ?? "";
		await expect(host.page.locator("[data-remote-peers] [data-remote-peer]")).toContainText("Online");
		// The code that paired is spent: a fresh one shows on B.
		await expect(codeRow).not.toContainText(code);
		await b.shoot("peer-online");

		// A: a session on B from the sidebar.
		await closeSettings(client.page);
		const section = client.page.locator(`[data-sidebar-device="${deviceId}"]`);
		await expect(section).toHaveAttribute("data-device-state", "online");
		await a.shoot("sidebar-device");
		await section.locator(`[data-sidebar-device-add="${deviceId}"]`).click();
		const picker = client.page.getByRole("dialog", { name: /Choose a folder on/ });
		const pickerPath = picker.locator("[data-remote-picker-path]");
		await expect(pickerPath).not.toHaveText("");
		await a.shoot("folder-picker");
		while ((await pickerPath.textContent()) !== path.parse(host.project).root) {
			const before = await pickerPath.textContent();
			await picker.locator("[data-remote-picker-up]").click();
			await expect(pickerPath).not.toHaveText(before ?? "");
		}
		let current = path.parse(host.project).root;
		for (const part of path.relative(current, host.project).split(path.sep)) {
			current = path.join(current, part);
			await picker.locator(`[data-remote-dir="${current}"]`).click();
			await expect(pickerPath).toHaveText(current);
		}
		await a.shoot("folder-picker-project");
		await picker.locator("[data-remote-picker-open]").click();
		await expect
			.poll(
				async () =>
					(await client?.page.evaluate(() => window.omp.tabs.list()))?.find(tab => tab.device === deviceId)
						?.status,
				{ timeout: 60_000 },
			)
			.toBe("ready");
		await client.page.locator("textarea").first().fill("remote hello");
		await client.page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(
			client.page.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" }),
		).toHaveCount(1);
		await a.shoot("remote-session");
		// The right panel on a remote tab: the files are B's, the terminal is local-only.
		const aside = client.page.locator("aside[data-docked]");
		await pressShortcutUntilVisible(client.page, "ControlOrMeta+j", aside);
		await aside.locator(".omp-panel-topbar").getByRole("button", { name: "Files", exact: true }).click();
		await a.shoot("remote-files");
		await aside.locator(".omp-panel-topbar").getByRole("button", { name: "Terminal", exact: true }).click();
		await a.shoot("remote-terminal");
		await openSettings(client.page, "models");
		await a.shoot("remote-models");
		await closeSettings(client.page);

		// B restarts on the same port: A shows the drop, then reconnects by itself.
		await b.finish(host.errors);
		await exitApp(host.app);
		host = null;
		await expect(client.page.locator(`[data-remote-reconnecting="${deviceId}"]`)).toBeVisible();
		await a.shoot("host-gone");
		host = await launch(hostRoot, { env: hostEnv(port) });
		await expect(client.page.locator(`[data-remote-reconnecting="${deviceId}"]`)).toHaveCount(0, {
			timeout: 60_000,
		});
		await expect(section).toHaveAttribute("data-device-state", "online", { timeout: 60_000 });
		a.notes.push(
			`after the host restart: ${JSON.stringify((await client.page.evaluate(() => window.omp.tabs.list())).map(tab => ({ device: tab.device, status: tab.status })))}`,
		);
		await a.shoot("host-back");

		// B removes A: A's host row leaves the online state; A forgets B.
		const b2 = recorder(host.page, "remote-host-restarted");
		await openSettings(host.page, "connections");
		await expect(host.page.locator("[data-remote-peers] [data-remote-peer]")).toContainText("Online", {
			timeout: 60_000,
		});
		await b2.shoot("peer-back");
		// At the smallest window the row truncates "Last seen …"; hover still names it in full.
		await resize(host.app, 800, 640);
		const peerRow = host.page.locator("[data-remote-peers] [data-remote-peer]");
		await expect(peerRow.locator('[title^="Last seen"]')).toHaveCount(1);
		await expect(peerRow.locator("[title]").first()).toHaveAttribute("title", /\S/);
		await b2.shoot("peer-back-800");
		await resize(host.app, 1440, 900);
		await host.page.getByRole("button", { name: /^Remove / }).click();
		const revoke = host.page.getByRole("dialog").or(host.page.getByRole("alertdialog"));
		await expect(revoke).toBeVisible();
		await b2.shoot("peer-remove-confirm");
		await revoke.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(host.page.locator("[data-remote-peers]")).toHaveCount(0);
		await b2.shoot("peer-removed");
		await openSettings(client.page, "connections");
		await expect(hostRow).not.toContainText("Online", { timeout: 30_000 });
		a.notes.push(`host row after B removed A: ${await hostRow.textContent()}`);
		await a.shoot("removed-by-host");
		await client.page.getByRole("button", { name: /^Remove / }).click();
		const forget = client.page.getByRole("dialog").or(client.page.getByRole("alertdialog"));
		await expect(forget).toBeVisible();
		await a.shoot("forget-confirm");
		await forget.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(client.page.locator("[data-remote-hosts]")).toHaveCount(0);
		await a.shoot("forgot-host");
		await closeSettings(client.page);
		await a.shoot("sidebar-after-forget");
		await b2.finish(host.errors);
		expect(client.errors).toEqual([]);
	} finally {
		await a.finish(client?.errors ?? []);
		if (host) await exitApp(host.app);
		if (client) await exitApp(client.app);
		host = null;
		client = null;
		await cleanup(root);
	}
});

// ── Providers and accounts: add, API key, remove, rotation, custom form, relaunch ──
test("provider and account flows", async () => {
	test.setTimeout(240_000);
	const root = await tempRoot("providers");
	const env = { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1" };
	let instance: Instance | null = await launch(root, { env });
	const rec = recorder(instance.page, "providers");
	try {
		const { page, app } = instance;
		await app.evaluate(({ shell }) => {
			const opened: string[] = [];
			Object.assign(globalThis, { openedUrls: opened });
			shell.openExternal = async (url: string) => {
				opened.push(url);
			};
		});
		const settings = await openSettings(page, "models");
		await expect(settings.getByText("Anthropic", { exact: true }).first()).toBeVisible();
		await rec.shoot("models");

		// Anthropic expands to its two accounts; "Add another account" signs in a third.
		const anthropic = settings
			.locator("li")
			.filter({ has: page.locator("button[aria-controls]") })
			.filter({
				hasText: "Anthropic",
			});
		await anthropic.locator("button[aria-controls]").click();
		const accounts = settings.getByRole("region", { name: "Anthropic accounts" });
		await expect(accounts).toContainText("work@example.com");
		await expect(accounts).toContainText("home@example.com");
		await rec.shoot("accounts");
		await accounts.getByRole("button", { name: "Add another account" }).click();
		await expect(anthropic.getByRole("button", { name: "Sign in with browser" })).toBeVisible();
		await rec.shoot("add-account-sign-in");
		await anthropic.getByRole("button", { name: "Sign in with browser" }).click();
		// The browser sign-in waits for its callback; the code paste is the fallback behind a toggle.
		await anthropic.getByRole("button", { name: "Browser can't get back to OMPdesk? Paste the code" }).click();
		await anthropic
			.getByLabel("Authorization code or redirect address")
			.fill("http://localhost:54545/callback?code=abc&state=xyz");
		await anthropic.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(page.getByText("Signed in to Anthropic")).toBeVisible();
		await expect(accounts).toContainText("added-3@example.com");
		await expect(anthropic).toContainText("3 accounts");
		await rec.shoot("account-added");

		// Remove the added account through its confirmation.
		await accounts.getByRole("button", { name: "Remove added-3@example.com" }).click();
		const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Remove this account?" }));
		await expect(confirm).toBeVisible();
		await rec.shoot("remove-confirm");
		await confirm.getByRole("button", { name: "Remove account" }).click();
		await expect(page.getByText("Removed added-3@example.com from Anthropic")).toBeVisible();
		await expect(accounts).not.toContainText("added-3@example.com");
		await expect(anthropic).toContainText("2 accounts");
		await rec.shoot("account-removed");

		// Rotation mode: Even, written to prefs and kept over a relaunch below.
		const rotation = settings.locator("[data-account-rotation]");
		await expect(rotation).not.toHaveAttribute("data-account-rotation", "loading");
		await rotation.getByRole("radio", { name: "Even" }).click();
		await expect(rotation).toHaveAttribute("data-account-rotation", "even");
		await expect.poll(() => page.evaluate(() => window.omp.prefs.get("accountRotation"))).toBe("even");
		await rec.shoot("rotation-even");

		// An API-key provider from the long tail: the key page, the masked key, connected.
		await settings.getByRole("button", { name: "Add a provider" }).click();
		await settings.getByRole("searchbox", { name: "Search providers" }).fill("DeepSeek");
		const deepseek = settings.locator("li").filter({ has: page.getByText("DeepSeek", { exact: true }) });
		await rec.shoot("picker-search");
		await deepseek.getByRole("button", { name: "Connect", exact: true }).click();
		const key = deepseek.locator('input[type="password"]');
		await expect(key).toBeVisible();
		await expect(deepseek.getByRole("button", { name: "Open key page" })).toBeVisible();
		await rec.shoot("api-key-prompt");
		await key.fill("sk-audit-key");
		await deepseek.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(page.getByText("Signed in to DeepSeek")).toBeVisible();
		const connectedDeepseek = settings
			.locator("li")
			.filter({ has: page.getByRole("button", { name: "Sign out", exact: true }) })
			.filter({ hasText: "DeepSeek" });
		await expect(connectedDeepseek).toContainText("API key");
		await rec.shoot("api-key-connected");

		// Sign out of it.
		await connectedDeepseek.getByRole("button", { name: "Sign out", exact: true }).click();
		const logout = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Sign out of DeepSeek?" }));
		await expect(logout).toBeVisible();
		await rec.shoot("sign-out-confirm");
		await logout.getByRole("button", { name: "Clear credentials" }).click();
		await expect(page.getByText("Signed out of DeepSeek")).toBeVisible();
		await expect(connectedDeepseek).toHaveCount(0);
		await rec.shoot("signed-out");

		// The custom endpoint form: add, edit, drop the stored key, delete.
		const modelsYml = path.join(root, "agent", "models.yml");
		await settings.getByRole("button", { name: "Add custom endpoint" }).click();
		await expect(settings.getByText("Add provider", { exact: true }).first()).toBeVisible();
		await rec.shoot("custom-form-empty");
		await settings.getByRole("button", { name: "Add provider", exact: true }).click();
		await rec.shoot("custom-form-errors");
		await settings.getByLabel(/^Provider ID/).fill("audit-proxy");
		await settings.getByLabel(/^Base URL/).fill("http://127.0.0.1:9/v1");
		await settings.getByRole("textbox", { name: /^API key/ }).fill("sk-custom");
		await settings
			.getByLabel(/^Model ID/)
			.first()
			.fill("audit-model");
		await rec.shoot("custom-form-filled");
		await settings.getByRole("button", { name: "Add provider", exact: true }).click();
		await expect(page.getByText(/Provider "audit-proxy" saved/)).toBeVisible();
		const custom = settings.locator("#settings-models-custom");
		await expect(custom).toContainText("audit-proxy");
		await expect.poll(async () => fs.readFile(modelsYml, "utf8")).toContain("audit-model");
		expect(await fs.readFile(modelsYml, "utf8")).toContain("sk-custom");
		// Back from the form at the endpoint it saved, with focus on it.
		const savedRow = custom.locator('[data-custom-provider="audit-proxy"]');
		await expect(savedRow).toBeInViewport({ ratio: 1 });
		await expect(savedRow.locator("button").first()).toBeFocused();
		await rec.shoot("custom-added");
		await custom.getByRole("button", { name: "Edit provider" }).click();
		await expect(settings.getByText("Edit provider", { exact: true }).first()).toBeVisible();
		await rec.shoot("custom-edit");
		await settings.getByRole("button", { name: "Remove stored key" }).click();
		await settings
			.getByLabel(/^Display name/)
			.first()
			.fill("Audit model");
		await rec.shoot("custom-edit-remove-key");
		await settings.getByRole("button", { name: "Save provider" }).click();
		await expect.poll(async () => fs.readFile(modelsYml, "utf8")).toContain("Audit model");
		expect(await fs.readFile(modelsYml, "utf8")).not.toContain("sk-custom");
		await page.waitForTimeout(800);
		await expect(savedRow).toBeInViewport({ ratio: 1 });
		await expect(savedRow.locator("button").first()).toBeFocused();
		await rec.shoot("custom-saved");
		await custom.getByRole("button", { name: "Delete" }).click();
		const del = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Delete provider" }));
		await expect(del).toBeVisible();
		await rec.shoot("custom-delete-confirm");
		await del.getByRole("button", { name: "Delete", exact: true }).click();
		await expect(page.getByText('Provider "audit-proxy" deleted')).toBeVisible();
		await expect(custom).not.toContainText("audit-proxy");
		expect(await fs.readFile(modelsYml, "utf8").catch(() => "")).not.toContain("audit-proxy");
		await rec.shoot("custom-deleted");

		// Relaunch: the rotation mode stays Even.
		await rec.finish(instance.errors);
		await exitApp(instance.app);
		instance = await launch(root, { env });
		const again = recorder(instance.page, "providers-relaunch");
		const settings2 = await openSettings(instance.page, "models");
		await expect(settings2.locator("[data-account-rotation]")).toHaveAttribute("data-account-rotation", "even");
		await again.shoot("rotation-kept");
		await again.finish(instance.errors);
		expect(instance.errors).toEqual([]);
	} finally {
		if (instance) await exitApp(instance.app);
		await cleanup(root);
	}
});

// ── Keyboard: remap a shortcut, relaunch, it persisted and fires ──
test("keyboard remap round trip", async () => {
	test.setTimeout(180_000);
	const root = await tempRoot("keyboard");
	let instance: Instance | null = await launch(root);
	const rec = recorder(instance.page, "keyboard");
	try {
		const { page } = instance;
		const settings = await openSettings(page, "keyboard");
		await rec.shoot("section");
		const keys = settings.locator('span:has(> [data-hotkey-action="panel.toggle"])');
		await keys.hover();
		await keys.getByRole("button", { name: "Change shortcut" }).click();
		await expect(settings.getByText("Press the new shortcut…")).toBeVisible();
		await rec.shoot("capturing");
		// A chord another action holds is refused before the free one is taken.
		await page.keyboard.press("ControlOrMeta+b");
		await expect(settings.getByRole("alert")).toBeVisible();
		await rec.shoot("conflict");
		await page.keyboard.press("Control+Shift+y");
		await expect(settings.getByRole("alert")).toHaveCount(0);
		await rec.shoot("captured");
		await settings.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByText(/“Toggle side panel” rebound to/)).toBeVisible();
		const stored = await page.evaluate(() => window.omp.prefs.get("keymapOverrides"));
		rec.notes.push(`stored overrides: ${JSON.stringify(stored)}`);
		await rec.shoot("saved");
		await closeSettings(page);

		// It fires now; the old chord no longer opens the panel.
		const aside = page.locator("aside[data-docked]");
		await expect(aside).toHaveCount(0);
		await page.keyboard.press("ControlOrMeta+j");
		await page.waitForTimeout(300);
		rec.notes.push(`old chord opened the panel: ${await aside.isVisible()}`);
		if (await aside.isVisible()) await page.keyboard.press("ControlOrMeta+j");
		await pressShortcutUntilVisible(page, "Control+Shift+y", aside);
		await rec.shoot("fired");
		await page.keyboard.press("Control+Shift+y");
		await expect(aside).toHaveCount(0);

		// Relaunch: still remapped, shown as Changed, and it fires.
		await rec.finish(instance.errors);
		await exitApp(instance.app);
		instance = await launch(root);
		const again = recorder(instance.page, "keyboard-relaunch");
		const settings2 = await openSettings(instance.page, "keyboard");
		const row = settings2.locator('[data-hotkey-action="panel.toggle"]');
		await expect(row).toContainText(/Y/);
		await again.shoot("persisted");
		await closeSettings(instance.page);
		const aside2 = instance.page.locator("aside[data-docked]");
		await pressShortcutUntilVisible(instance.page, "Control+Shift+y", aside2);
		await again.shoot("fires-after-relaunch");
		// The palette names the new chord.
		await instance.page.keyboard.press("ControlOrMeta+k");
		await instance.page.keyboard.type("side panel");
		await again.shoot("palette");
		await instance.page.keyboard.press("Escape");
		await again.finish(instance.errors);
		expect(instance.errors).toEqual([]);
	} finally {
		if (instance) await exitApp(instance.app);
		await cleanup(root);
	}
});

// ── A terminal that cannot start: a titled banner with the cleaned-up cause and a retry ──
for (const [language, theme] of [
	["en", "light"],
	["ko", "dark"],
] as const) {
	test(`terminal failure banner ${language}-${theme}`, async () => {
		test.setTimeout(120_000);
		const root = await tempRoot(`terminal-${language}`);
		const instance = await launch(root, { language, theme, withoutNatives: true });
		const rec = recorder(instance.page, `terminal-failed-${language}-${theme}`);
		try {
			const aside = instance.page.locator("aside[data-docked]");
			await pressShortcutUntilVisible(instance.page, "ControlOrMeta+j", aside);
			// The view buttons lead the header; Terminal is the first.
			await aside.locator(".omp-panel-topbar").getByRole("button").first().click();
			const banner = aside.locator('[role="alert"], [role="status"]').filter({
				hasText: language === "en" ? "The terminal didn't respond" : /터미널/,
			});
			await expect(banner.first()).toBeVisible({ timeout: 30_000 });
			const text = (await banner.first().innerText()).replace(/\s+/g, " ");
			rec.notes.push(`banner: ${text}`);
			expect(text).not.toContain("Error invoking remote method");
			await rec.shoot("banner");
			await aside.getByRole("button", { name: language === "en" ? "Retry" : "다시 시도" }).click();
			await expect(banner.first()).toBeVisible({ timeout: 30_000 });
			await rec.shoot("banner-after-retry");
			expect(instance.errors).toEqual([]);
		} finally {
			await rec.finish(instance.errors);
			await exitApp(instance.app);
			await cleanup(root);
		}
	});
}

/** A git project with numbered files, a 1,200-line rewrite and a plan, behind a stand-in `gh`. */
async function seedProject(root: string): Promise<{ plan: string; bin: string }> {
	const project = path.join(root, "project");
	const bin = path.join(root, "ghbin");
	await Promise.all([fs.mkdir(path.join(project, "steps"), { recursive: true }), fs.mkdir(bin, { recursive: true })]);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
	git("init", "--quiet");
	git("config", "user.email", "audit@example.com");
	git("config", "user.name", "Audit");
	for (const index of [1, 2, 3, 9, 10, 11, 20, 100]) {
		await fs.writeFile(path.join(project, `file-${index}.txt`), `file ${index}\n`);
		await fs.mkdir(path.join(project, "steps", `step-${index}`), { recursive: true });
		await fs.writeFile(path.join(project, "steps", `step-${index}`, "README.md"), `# Step ${index}\n`);
	}
	const lines = (prefix: string) => Array.from({ length: 1_200 }, (_, index) => `${prefix} line ${index + 1}`);
	await fs.writeFile(path.join(project, "big.ts"), `${lines("const a =").join("\n")}\n`);
	git("add", ".");
	git("commit", "--quiet", "-m", "seed");
	await fs.writeFile(path.join(project, "big.ts"), `${lines("const b =").join("\n")}\n`);
	const plan = path.join(project, "plan.md");
	await fs.writeFile(plan, "# Delivery plan\n\n- [x] Inspect\n- [ ] Ship\n");
	const title = "Keep the selected pull request readable beside the list at the smallest window";
	const pr = { number: 7, title, url: "https://github.com/o/r/pull/7", author: { login: "dev" }, headRefName: "fix" };
	await fs.writeFile(path.join(bin, "list.json"), JSON.stringify([pr]));
	await fs.writeFile(path.join(bin, "view.json"), JSON.stringify({ ...pr, baseRefName: "main", body: "Body" }));
	await fs.writeFile(
		path.join(bin, "gh"),
		`#!/bin/sh\ncase "$1 $2" in\n"repo view") echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;\n"pr list") cat "${bin}/list.json" ;;\n"pr view") cat "${bin}/view.json" ;;\n*) exit 1 ;;\nesac\n`,
		{ mode: 0o755 },
	);
	return { plan, bin };
}

// ── Every settings section, Stats, Agents and every panel view, per language/theme ──
for (const [language, theme] of [
	["en", "light"],
	["ko", "dark"],
] as const) {
	test(`panels, settings and stats walk ${language}-${theme}`, async () => {
		test.setTimeout(300_000);
		const root = await tempRoot(`walk-${language}`);
		const { plan, bin } = await seedProject(root);
		const instance = await launch(root, {
			language,
			theme,
			env: {
				OMP_GUI_TEST_LOGIN: "1",
				OMP_GUI_TEST_MODELS: "1",
				OMP_GUI_TEST_PANEL_PLAN: plan,
				PATH: `${bin}${path.delimiter}${process.env.PATH}`,
			},
		});
		const { page, app } = instance;
		const rec = recorder(page, `walk-${language}-${theme}`);
		try {
			// Settings: every section, wide and at the smallest window.
			const sections = ["general", "appearance", "keyboard", "models", "agent", "tools", "permissions"];
			sections.push("workspace", "connections", "updates", "advanced");
			for (const [width, height] of [
				[1440, 900],
				[800, 640],
			] as const) {
				await resize(app, width, height);
				for (const section of sections) {
					const settings = await openSettings(page, section);
					await expect(settings.locator(`[data-settings-section="${section}"]`)).toBeVisible();
					await page.waitForTimeout(250);
					await rec.shoot(`settings-${section}-${width}`);
				}
				await closeSettings(page);
			}
			await resize(app, 1440, 900);

			// Stats: both scopes and every section tab.
			await page.locator('[data-sidebar-destinations] button[data-destination="insights"]').click();
			const stats = page.locator('section[data-destination="insights"]');
			await expect(stats).toBeVisible();
			await page.waitForTimeout(600);
			await rec.shoot("stats-session");
			const tabs = stats.getByRole("tab");
			for (let index = 0; index < (await tabs.count()); index++) {
				await tabs.nth(index).click();
				await page.waitForTimeout(600);
				await rec.shoot(`stats-tab-${index}`);
			}
			rec.notes.push(`stats text: ${(await stats.innerText()).slice(0, 400).replace(/\s+/g, " ")}`);
			// Usage: stock's provider name and the limit windows in the UI language, never ids.
			await stats.getByRole("tab", { name: language === "ko" ? "사용량" : "Usage", exact: true }).click();
			const card = stats.locator("section").filter({ hasText: "work@example.com" }).first();
			await expect(card.locator("h3")).toHaveText("Anthropic");
			await expect(card).toContainText(language === "ko" ? "5시간 한도" : "5-hour limit");
			await expect(card).toContainText(language === "ko" ? "주간 한도" : "Weekly limit");
			await expect(card).not.toContainText(/\banthropic\b|Claude 5 Hour|Week\b/);
			await rec.shoot("stats-usage");

			// Agents: every tab, then the pull requests at the smallest window.
			await page.locator('[data-sidebar-destinations] button[data-destination="agents"]').click();
			const agents = page.locator('section[data-destination="agents"]');
			await expect(agents).toBeVisible();
			const agentTabs = agents.getByRole("tab");
			await expect(agentTabs.first()).toBeVisible();
			for (let index = 0; index < (await agentTabs.count()); index++) {
				await agentTabs.nth(index).click();
				await page.waitForTimeout(500);
				await rec.shoot(`agents-tab-${index}`);
			}
			await resize(app, 800, 640);
			// The pull request detail beside its list at the smallest window.
			await agents.getByRole("tab", { name: /^(Pull requests|풀 리퀘스트)$/ }).click();
			// The row's name also carries its state, number and branch.
			const prTitle = /Keep the selected pull request readable/;
			await agents.getByRole("button", { name: prTitle }).click({ timeout: 20_000 });
			await expect(agents.getByRole("heading", { name: prTitle })).toBeVisible();
			const detailWidth = await agents
				.getByRole("navigation", { name: /^(Pull requests|풀 리퀘스트)$/ })
				.evaluate(list => Math.round(list.nextElementSibling?.getBoundingClientRect().width ?? 0));
			rec.notes.push(`pr detail width at 800: ${detailWidth}`);
			await page.waitForTimeout(400);
			await rec.shoot("pr-detail-800");
			await resize(app, 1440, 900);
			await page.keyboard.press("Escape");

			// The right panel: every view, Files in natural order, the big diff, a cancelled task.
			const aside = page.locator("aside[data-docked]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
			const topbar = aside.locator(".omp-panel-topbar");
			const views = ["Terminal", "Changes", "Preview", "Files"];
			const koViews: Record<string, string> = {};
			for (const view of views) {
				// The view buttons lead the header, in this order, in either language.
				const button = topbar.getByRole("button").nth(views.indexOf(view));
				koViews[view] = (await button.getAttribute("aria-label")) ?? view;
			}
			for (const view of views) {
				await topbar.getByRole("button", { name: koViews[view], exact: true }).click();
				await page.waitForTimeout(400);
				await rec.shoot(`panel-${view.toLowerCase()}`);
			}
			// Files: numbered names in natural order.
			await topbar.getByRole("button", { name: koViews.Files, exact: true }).click();
			const names = await aside.locator('[role="treeitem"]').allInnerTexts();
			const files = names.map(name => name.trim()).filter(name => /^file-\d+\.txt$/.test(name));
			rec.notes.push(`file order: ${files.join(", ")}`);
			expect(files).toEqual([1, 2, 3, 9, 10, 11, 20, 100].map(index => `file-${index}.txt`));
			const folder = aside.locator('[role="treeitem"]').filter({ hasText: /^steps$/ });
			if (await folder.count()) {
				await folder.first().click();
				await page.waitForTimeout(300);
				rec.notes.push(
					`step order: ${(await aside.locator('[role="treeitem"]').allInnerTexts())
						.map(name => name.trim())
						.filter(name => /^step-\d+$/.test(name))
						.join(", ")}`,
				);
			}
			await rec.shoot("files-natural-order");
			// Changes: the 1,200-line rewrite keeps four-digit line numbers on one line.
			await topbar.getByRole("button", { name: koViews.Changes, exact: true }).click();
			await aside.locator('button[title="big.ts"]').click();
			const preview = aside.locator(".omp-changes-preview");
			await expect(preview).toContainText("const a = line 1", { timeout: 20_000 });
			// The diff renders only the rows in view: scroll to the end before reading the last line.
			await expect(async () => {
				await preview.evaluate(element => element.scrollTo({ top: element.scrollHeight }));
				await expect(preview).toContainText("const b = line 1200", { timeout: 1_000 });
			}).toPass({ timeout: 20_000 });
			await page.waitForTimeout(300);
			const gutters = await aside.locator(".omp-pane-gutter").evaluateAll(cells =>
				cells
					.filter(cell => (cell.textContent ?? "").trim().length === 4)
					.slice(0, 5)
					.map(cell => Math.round(cell.getBoundingClientRect().height)),
			);
			rec.notes.push(`four-digit gutter heights: ${gutters.join(",")}`);
			await rec.shoot("changes-big-diff-end");
			// Background tasks: cancel the running one; it turns cancelled in place.
			const options = aside.getByRole("button", { name: /View options|보기 옵션/ });
			await options.click();
			await page.getByRole("menuitemcheckbox").first().click();
			const watch = aside.locator('[data-job-id="watch"]');
			await expect(watch).toBeVisible();
			await rec.shoot("jobs");
			await watch
				.getByRole("button")
				.filter({ hasText: /Cancel|취소/ })
				.click();
			await expect(aside.locator('[data-job-id="watch"]')).toBeVisible();
			await page.waitForTimeout(400);
			rec.notes.push(
				`watch job after cancel: ${(await aside.locator('[data-job-id="watch"]').innerText()).replace(/\s+/g, " ")}`,
			);
			await rec.shoot("jobs-cancelled");
			// The remaining views from View options.
			const items = page.getByRole("menuitemcheckbox");
			await options.click();
			const count = await items.count();
			await page.keyboard.press("Escape");
			for (let index = 1; index < count; index++) {
				await options.click();
				await items.nth(index).click();
				await page.waitForTimeout(400);
				await rec.shoot(`panel-option-${index}`);
			}
			expect(instance.errors).toEqual([]);
		} finally {
			await rec.finish(instance.errors);
			await exitApp(app);
			await cleanup(root);
		}
	});
}
