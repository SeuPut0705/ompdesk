/**
 * Connecting GitHub installs the GitHub CLI right then, end to end, with the
 * fake installer (`OMP_GUI_TEST_INSTALLER`: every plan runs
 * `<installer> <item> <method>`). gh is nowhere on the app's PATH (the login
 * shell is a stand-in that reports a PATH without gh) and setup's ledger has
 * gh in its daily back-off after three misses, the state a user who "never got
 * gh" is in. In Settings › General the card offers the sign-in; the
 * click installs gh through setup's gh item: main's download holds at half so
 * the card shows "Installing GitHub CLI…" with its bytes, the first install
 * fails with a network reason and Retry, the retry puts the fake gh into the
 * managed tools dir, and the sign-in carries on by itself to the device code
 * and the signed-in account — no other click, no relaunch. Captures in en/ko.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { seedFakeGh, writeFakeGh } from "../src/main/github-auth/test-fake-gh";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { exitApp, fixtureOmp, pressShortcutUntilVisible, variants } from "./harness";

/** gh attempt 1 fails offline; attempt 2 copies the fake gh into the managed tools dir. Other items never run here. */
const INSTALLER = `
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [item, method] = process.argv.slice(2);
const dir = process.env.OMPDESK_FAKE_INSTALLER_DIR;
appendFileSync(join(dir, "installs.log"), item + " " + method + "\\n");
if (item !== "gh") process.exit(0);
const counter = join(dir, "gh-attempts");
const attempt = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(attempt));
console.log("==> Fetching gh (attempt " + attempt + ")");
if (attempt === 1) {
	console.error("curl: (6) Could not resolve host: ghcr.io");
	process.exit(6);
}
const target = process.env.OMPDESK_FAKE_GH_TARGET;
mkdirSync(target, { recursive: true });
copyFileSync(process.env.OMPDESK_FAKE_GH_SOURCE, join(target, "gh"));
chmodSync(join(target, "gh"), 0o755);
console.log("==> Pouring gh");
`;

const DOWNLOAD = new Uint8Array(4 * 1_048_576).map((_, index) => index % 251);

/** Serves DOWNLOAD with its size; the first request stops at half until `finish`. */
async function downloadServer() {
	const held = Promise.withResolvers<void>();
	let requests = 0;
	const server = createServer((_request, response) => {
		requests += 1;
		const first = requests === 1;
		response.writeHead(200, { "content-length": String(DOWNLOAD.byteLength) });
		const half = DOWNLOAD.byteLength / 2;
		response.write(DOWNLOAD.subarray(0, half));
		void (first ? held.promise : Promise.resolve()).then(() => response.end(DOWNLOAD.subarray(half)));
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return { server, url: `http://127.0.0.1:${port}/gh.zip`, finish: () => held.resolve() };
}

/** The test's PATH without any directory that holds a gh, so the user's own gh never answers. */
function pathWithoutGh(): string {
	return (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(dir => dir && !existsSync(path.join(dir, "gh")))
		.join(path.delimiter);
}

for (const language of variants(["en", "ko"] as const)) {
	test(`connecting GitHub installs the missing GitHub CLI, then signs in (${language})`, async () => {
		test.skip(
			process.platform === "win32",
			"Windows installs gh through winget only (selectMethod in src/main/setup/plans.ts): no archive download, no byte progress, no managed tools/gh/bin, which is the install this spec drives",
		);
		test.setTimeout(120_000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gh-install-${language}-`));
		const home = path.join(root, "home");
		const desktop = path.join(root, "desktop");
		const project = path.join(root, "project");
		const agent = path.join(root, "agent");
		const installerDir = path.join(root, "installer");
		await Promise.all([home, desktop, project, agent, installerDir].map(dir => fs.mkdir(dir)));
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: "light", firstRunComplete: true }),
		);
		// Three automatic misses today: the launch leaves gh alone ("Paused after failed attempts").
		const missed = { failures: 3, lastAttempt: Date.now() };
		await fs.writeFile(path.join(desktop, "setup-state.json"), JSON.stringify({ gh: missed, node: missed }));
		const fakeGh = await writeFakeGh(root);
		const ghState = path.join(root, "gh-state.json");
		await seedFakeGh(ghState, []);
		const gitConfig = path.join(home, ".gitconfig");
		await fs.writeFile(gitConfig, "");
		const bin = await fixtureOmp(root);
		const natives =
			process.env.OMP_GUI_TEST_NATIVES ||
			path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
		await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "junction");
		const PATH = pathWithoutGh();
		// The login-shell probe would add /opt/homebrew/bin (path_helper); this one reports PATH as it is.
		const shell = path.join(root, "login-shell");
		await fs.writeFile(shell, `#!/bin/sh\nexec /usr/bin/env PATH='${PATH}' /bin/sh -c "$2"\n`, { mode: 0o755 });
		const installer = await writeFakeOmp(installerDir, INSTALLER);
		const download = await downloadServer();
		const env = {
			...process.env,
			PATH,
			SHELL: shell,
			HOME: home,
			GIT_CONFIG_GLOBAL: gitConfig,
			GIT_CONFIG_NOSYSTEM: "1",
			FAKE_GH_STATE: ghState,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: "omp-config",
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: bin,
			OMP_GUI_TEST_INSTALLER: installer,
			// Not the developer's own Homebrew: its gh would answer for the PATH this test emptied of gh.
			OMP_GUI_TEST_BREW_DIRS: "",
			OMP_GUI_TEST_DOWNLOAD: download.url,
			OMP_GUI_TEST_DOWNLOAD_SHA256: createHash("sha256").update(DOWNLOAD).digest("hex"),
			OMPDESK_FAKE_INSTALLER_DIR: installerDir,
			OMPDESK_FAKE_GH_SOURCE: fakeGh,
			// setup's managed tools dir (`<userData>/tools`), whose bin dirs main puts on PATH after an install.
			OMPDESK_FAKE_GH_TARGET: path.join(desktop, "tools", "gh", "bin"),
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [
				path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
				project,
				`--user-data-dir=${desktop}`,
			],
			env,
		});
		const page = await app.firstWindow();
		const shot = (name: string) =>
			page.screenshot({
				animations: "disabled",
				path: test.info().outputPath(`github-cli-install-${language}-${name}.png`),
			});
		const installs = async () =>
			(await fs.readFile(path.join(installerDir, "installs.log"), "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean);
		try {
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			await app.evaluate(({ BrowserWindow, shell }) => {
				BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 900);
				shell.openExternal = async () => {};
			});
			await page.waitForFunction(() => window.omp?.rpc != null);

			const settings = page.locator("[data-settings-page]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
			const section = settings.locator("#setting-github-account");
			await section.scrollIntoViewIfNeeded();
			const card = section.getByTestId("github-sign-in");
			await expect(card).toBeVisible({ timeout: 30_000 });
			await expect(card).toHaveAttribute("data-github-phase", "missing");
			// Backed off at launch: nothing installed on its own.
			expect(await installs()).toEqual([]);
			await expect(card).toContainText(
				language === "en" ? "Signing in installs the GitHub CLI first" : "로그인하면 GitHub CLI를 먼저 설치해요",
			);
			await shot("1-missing");

			await card.getByTestId("github-sign-in-start").click();
			await expect(card).toHaveAttribute("data-github-phase", "installing");
			const install = card.locator('[data-setup-install="gh"]');
			await expect(install).toContainText(language === "en" ? "Installing GitHub CLI…" : "GitHub CLI 설치 중…");
			await expect(install.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0.5");
			await expect(install).toContainText(/2\.0 MB/);
			await shot("2-installing");

			download.finish();
			await expect(install).toHaveAttribute("data-setup-install-phase", "failed", { timeout: 30_000 });
			await expect(install).toContainText(
				language === "en" ? "Couldn't install GitHub CLI." : "GitHub CLI 설치에 실패했어요.",
			);
			await expect(install).toContainText(
				language === "en" ? "couldn't reach the internet" : "인터넷에 연결하지 못했어요",
			);
			await shot("3-failed");

			// Retry is the user's own: it runs again at once, and the sign-in carries on when gh lands.
			await install.getByTestId("setup-install-retry").click();
			const code = card.getByTestId("github-device-code");
			await expect(code).toContainText("ABCD-1234", { timeout: 30_000 });
			await expect(card).toContainText("gh 2.62.0");
			// Homebrew where this Mac has it, else the verified archive: each run is the fake installer.
			const ran = await installs();
			expect(ran).toHaveLength(2);
			for (const line of ran) expect(line).toMatch(/^gh (brew|archive)$/);
			await shot("4-code");

			await card.getByTestId("github-open").click();
			await expect(card).toHaveAttribute("data-github-phase", "signed-in", { timeout: 30_000 });
			await expect(card.getByTestId("github-identity")).toContainText("The Octocat <octocat@example.com>");
			await shot("5-signed-in");
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			download.finish();
			download.server.close();
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
