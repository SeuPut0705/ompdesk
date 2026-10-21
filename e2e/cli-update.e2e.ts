/**
 * The vendor CLIs of connected accounts keep current, end to end, with the fake installer
 * (`OMP_GUI_TEST_INSTALLER`; `OMP_GUI_TEST_CLI_UPDATES=1` lets a test launch check on its own, like the
 * packaged app). Two accounts are connected through a stand-in `discoverAuthStorage` in the fixture omp's
 * package (the stock helper reads it): Anthropic, whose Claude Code 2.0.1 is installed with its own updater,
 * and OpenAI, whose Codex is the copy inside ChatGPT.app. Claude goes check → update → re-detect with nobody
 * clicking: the installer holds the update so This computer shows "Updating…" and a disabled Update now, then
 * releases it and the row reads 2.1.0 from `claude --version`. The bundled Codex is listed with the reason it
 * is left alone and is never checked or touched. With the pref off nothing runs at launch; Update now runs
 * the same cycle. Captures in en/ko.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { exitApp, fixtureOmp, launchApp, pressShortcutUntilVisible, variants } from "./harness";

/**
 * `cli-<tool> <method> check` prints the newest version; `update` waits while the `hold` file exists, then
 * "installs" 2.1.0 by writing the version file the fake claude prints. Every call is logged.
 */
const INSTALLER = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dir = process.env.OMPDESK_FAKE_INSTALLER_DIR;
appendFileSync(join(dir, "installs.log"), args.join(" ") + "\\n");
if (args[0] === "cli-claude" && args[2] === "check") console.log("2.1.0");
if (args[0] === "cli-claude" && args[2] === "update") {
	while (existsSync(join(dir, "hold"))) await Bun.sleep(25);
	writeFileSync(process.env.OMPDESK_FAKE_CLAUDE_VERSION, "2.1.0");
	console.log("Updated Claude Code to 2.1.0");
}
`;

/** The stand-in stock sdk: the providers with a stored credential come from the test's environment. */
const FAKE_SDK = `
export const isManagedMCPOAuthCredentialId = id => typeof id === "string" && id.startsWith("mcp_oauth");
export async function discoverAuthStorage() {
	const providers = (process.env.OMPDESK_FAKE_PROVIDERS ?? "").split(",").filter(Boolean);
	return {
		credentials: { reload: async () => {}, list: () => providers.map((provider, id) => ({ id, provider })) },
		close() {},
	};
}
`;

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
	versionFile: string;
	errors: string[];
}

const WIN = process.platform === "win32";
const TOOL_NAMES = ["claude", "codex", "gemini", "cursor-agent", "copilot", "gh", "node"];
/** The files a tool is found as along a PATH: the bare name, or `.exe` and `.cmd` on Windows. */
const TOOL_FILES = TOOL_NAMES.flatMap(name => (WIN ? [`${name}.exe`, `${name}.cmd`] : [name]));

/** The test's PATH without any directory that holds one of the tools, so the developer's own never answers. */
function cleanPath(...extra: string[]): string {
	const rest = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(dir => dir && !TOOL_FILES.some(file => existsSync(path.join(dir, file))));
	return [...extra, ...rest].join(path.delimiter);
}

async function launch(name: string, prefs: Record<string, unknown>): Promise<Launched> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-cli-update-${name}-`)));
	const home = path.join(root, "home");
	const desktop = path.join(root, "desktop");
	const project = path.join(root, "project");
	const agent = path.join(root, "agent");
	const installerDir = path.join(root, "installer");
	const bin = path.join(root, "bin");
	await Promise.all([home, desktop, project, agent, installerDir, bin].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ firstRunComplete: true, themeName: "light", ...prefs }),
	);
	// Machine setup's optional gh and Node have nothing to install here: keep the launch quiet.
	const missed = { failures: 3, lastAttempt: Date.now() };
	await fs.writeFile(path.join(desktop, "setup-state.json"), JSON.stringify({ gh: missed, node: missed }));

	// Claude Code 2.0.1, installed with its own updater and found on PATH: on POSIX under …/share/claude/versions/…,
	// linked from a bin dir; on Windows a `.cmd` shim in the bin dir. The Codex inside the ChatGPT app, which updates
	// it: `ChatGPT.app/Contents/` on a Mac, the app's `WindowsApps` package folder on Windows.
	const versionFile = path.join(root, "claude-version");
	await fs.writeFile(versionFile, "2.0.1");
	let codexDir = bin;
	if (WIN) {
		await fs.writeFile(
			path.join(bin, "claude.cmd"),
			`@echo off\r\nset /p version=<"${versionFile}"\r\necho %version% (Claude Code)\r\n`,
		);
		codexDir = path.join(root, "WindowsApps", "OpenAI.ChatGPT");
		await fs.mkdir(codexDir, { recursive: true });
		await fs.writeFile(path.join(codexDir, "codex.cmd"), "@echo off\r\necho codex-cli 0.46.0\r\n");
	} else {
		const claude = path.join(home, ".local", "share", "claude", "versions", "stable", "claude");
		await fs.mkdir(path.dirname(claude), { recursive: true });
		await fs.writeFile(claude, `#!/bin/sh\necho "$(cat '${versionFile}') (Claude Code)"\n`, { mode: 0o755 });
		await fs.symlink(claude, path.join(bin, "claude"));
		const codex = path.join(root, "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
		await fs.mkdir(path.dirname(codex), { recursive: true });
		await fs.writeFile(codex, "#!/bin/sh\necho 'codex-cli 0.46.0'\n", { mode: 0o755 });
		await fs.symlink(codex, path.join(bin, "codex"));
	}

	const omp = await fixtureOmp(root);
	const stock = path.join(path.dirname(omp), "node_modules", "@oh-my-pi", "pi-coding-agent");
	const manifest: { exports: Record<string, string> } = JSON.parse(
		await fs.readFile(path.join(stock, "package.json"), "utf8"),
	);
	manifest.exports["./sdk"] = "./sdk.ts";
	manifest.exports["./mcp/oauth-flow"] = "./sdk.ts";
	await fs.writeFile(path.join(stock, "package.json"), JSON.stringify(manifest));
	await fs.writeFile(path.join(stock, "sdk.ts"), FAKE_SDK);

	const PATH = cleanPath(bin, ...(codexDir === bin ? [] : [codexDir]));
	// The login-shell probe would add Homebrew's dirs (path_helper); this one reports PATH as it is. Windows has no probe.
	const shell = path.join(root, "login-shell");
	if (!WIN)
		await fs.writeFile(shell, `#!/bin/sh\nexec /usr/bin/env PATH='${PATH}' /bin/sh -c "$2"\n`, { mode: 0o755 });
	const installer = await writeFakeOmp(installerDir, INSTALLER);
	await fs.writeFile(path.join(installerDir, "hold"), "");
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: {
			PATH,
			...(WIN ? {} : { SHELL: shell }),
			HOME: home,
			PI_CONFIG_DIR: "omp-config",
			OMP_GUI_OMP: omp,
			OMP_GUI_TEST_INSTALLER: installer,
			OMP_GUI_TEST_CLI_UPDATES: "1",
			OMP_GUI_TEST_BREW_DIRS: "",
			OMPDESK_FAKE_INSTALLER_DIR: installerDir,
			OMPDESK_FAKE_CLAUDE_VERSION: versionFile,
			OMPDESK_FAKE_PROVIDERS: "anthropic,openai-codex",
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page, root, versionFile, errors };
}

async function close(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function installs(launched: Launched): Promise<string[]> {
	const log = await fs.readFile(path.join(launched.root, "installer", "installs.log"), "utf8").catch(() => "");
	return log.split("\n").filter(line => line.startsWith("cli-"));
}

const release = (launched: Launched) => fs.rm(path.join(launched.root, "installer", "hold"), { force: true });

async function openThisComputer(page: Page) {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="updates"]').click();
	await expect(settings.locator("#setting-gui-toolsAutoUpdate")).toBeVisible();
	return settings;
}

for (const language of variants(["en", "ko"] as const)) {
	test(`a connected account's Claude Code updates on its own: check, update, re-detect; a bundled Codex is left alone (${language})`, async () => {
		test.setTimeout(120_000);
		const launched = await launch(`auto-${language}`, { language });
		const { page } = launched;
		// The tool CLIs' rows end This computer's list, below the fold of a 900 px window: scroll them to the top.
		const shot = async (name: string) => {
			await page.locator("#setting-cli-tool-claude").evaluate(row => row.scrollIntoView({ block: "start" }));
			await page.mouse.move(1, 1);
			await page.locator("[data-settings-page]").screenshot({
				animations: "disabled",
				path: test.info().outputPath(`cli-update-${language}-${name}.png`),
			});
		};
		const t = (en: string, ko: string) => (language === "en" ? en : ko);
		try {
			const settings = await openThisComputer(page);
			const claude = settings.locator("#setting-cli-tool-claude");
			const codex = settings.locator("#setting-cli-tool-codex");
			await expect(settings.locator("#setting-gui-toolsAutoUpdate [role='switch']")).toHaveAttribute(
				"aria-checked",
				"true",
			);

			// Nobody clicked: main checked, found 2.1.0 > 2.0.1 and runs the update, which the installer holds.
			await expect(settings.getByTestId("cli-status-claude")).toHaveText(t("Updating…", "업데이트하는 중이에요…"), {
				timeout: 60_000,
			});
			await expect(settings.getByTestId("cli-version-claude")).toHaveText(
				t("Installed 2.0.1 · Latest 2.1.0", "설치됨 2.0.1 · 최신 2.1.0"),
			);
			await expect(claude).toContainText(t("Updated via its own updater", "업데이트 방법: 자체 업데이터"));
			await expect(claude.getByTestId("cli-update-now-claude")).toBeDisabled();
			await expect
				.poll(() => installs(launched), { timeout: 30_000 })
				.toEqual(["cli-claude self check", "cli-claude self update"]);

			// The Codex in ChatGPT.app is listed with its reason, and never checked or updated.
			await expect(settings.getByTestId("cli-version-codex")).toHaveText(t("Installed 0.46.0", "설치됨 0.46.0"));
			await expect(settings.getByTestId("cli-status-codex")).toHaveText(
				t(
					"This copy ships inside another app, which updates it.",
					"다른 앱 안에 들어 있는 사본이라 그 앱이 업데이트해요.",
				),
			);
			await expect(codex.getByTestId("cli-update-now-codex")).toBeDisabled();
			await shot("1-updating");

			await release(launched);
			await expect(settings.getByTestId("cli-status-claude")).toHaveText(
				t("Updated 2.0.1 → 2.1.0.", "2.0.1 → 2.1.0 업데이트했어요."),
				{ timeout: 30_000 },
			);
			// Re-detected: the tool itself reports 2.1.0 now.
			await expect(settings.getByTestId("cli-version-claude")).toHaveText(
				t("Installed 2.1.0 · Latest 2.1.0", "설치됨 2.1.0 · 최신 2.1.0"),
			);
			expect(await fs.readFile(launched.versionFile, "utf8")).toBe("2.1.0");
			await expect(claude.getByTestId("cli-update-now-claude")).toBeEnabled();
			await shot("2-updated");

			// Only claude was ever asked; machine setup's tools are not installed here, so nothing else is listed.
			expect(await installs(launched)).toEqual(["cli-claude self check", "cli-claude self update"]);
			await expect(settings.locator("[data-cli-tool]")).toHaveCount(2);
			expect(launched.errors).toEqual([]);
		} finally {
			await close(launched);
		}
	});
}
