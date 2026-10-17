/**
 * A first-time user without omp: a fresh profile (no prefs but the language
 * and theme), omp absent, the fake installer held mid-install, its first
 * attempt failing and the retry putting omp in place. While omp is missing or
 * installing nothing may look broken: the sidebar and the title bar never show
 * an error or a `role="alert"`, no toast fires, and no session-list read or
 * sidecar start reaches omp before it is usable. Once it is, the tab starts on
 * its own and the first-run provider step follows.
 *
 * Also measures the first-run wizard: launch → wizard visible with omp
 * present, and setup finished → wizard visible, from the startup marks in
 * `gui-runtime.jsonl` (`source: "startup-timing"`). Each test prints its
 * numbers and attaches them as `timing.json`.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { capture, exitApp, fixtureOmp, launchApp, variants } from "./harness";

test.describe.configure({ mode: "parallel" });

/** The fake installer: logs each call; omp waits for the test's `go-<attempt>` file, fails attempt 1, installs on attempt 2. */
const INSTALLER = `
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [item, method] = process.argv.slice(2);
const dir = process.env.OMPDESK_FAKE_INSTALLER_DIR;
appendFileSync(join(dir, "installs.log"), item + " " + method + "\\n");
if (item !== "omp") process.exit(0);
const counter = join(dir, "omp-attempts");
const attempt = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(attempt));
console.log("Resolving @oh-my-pi/pi-coding-agent (attempt " + attempt + ")");
while (!existsSync(join(dir, "go-" + attempt))) await Bun.sleep(25);
if (attempt === 1) {
	console.error("error: GET https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent - 503");
	process.exit(1);
}
renameSync(process.env.OMPDESK_FAKE_OMP + ".staged", process.env.OMPDESK_FAKE_OMP);
console.log("installed @oh-my-pi/pi-coding-agent with binaries:\\n - omp");
`;

declare global {
	interface Window {
		/** What `recordTrouble` saw: errors in the sidebar or title bar, and toasts. */
		__trouble?: string[];
	}
}

const DOWNLOAD = new Uint8Array(1_048_576).map((_, index) => index % 251);

interface DownloadServer {
	server: Server;
	url: string;
	/** Lets the held first request finish. */
	finish: () => void;
}

/** Serves DOWNLOAD; the first request stops at half until `finish`. */
async function downloadServer(): Promise<DownloadServer> {
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
	return { server, url: `http://127.0.0.1:${port}/omp.bin`, finish: () => held.resolve() };
}

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
	desktop: string;
	errors: string[];
	/** Lets the held install download finish (a no-op without the installer). */
	finishDownload: () => void;
	close: () => Promise<void>;
}

/**
 * A fresh profile: prefs hold only the language and theme. `installing`: omp is
 * absent and the fake installer puts it in place; `real`: the system omp on an
 * empty agent dir (no credentials, provider keys removed from the environment);
 * otherwise the fixture omp is there from the start. The fixture is signed out,
 * so the provider step shows.
 */
async function launch(
	name: string,
	language: "en" | "ko",
	theme: "light" | "dark",
	mode: "installing" | "present" | "real",
): Promise<Launched> {
	const installing = mode === "installing";
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-first-run-${name}-`));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const installerDir = path.join(root, "installer");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(installerDir)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, themeName: theme }));
	const omp = await fixtureOmp(root);
	const env: Record<string, string | undefined> =
		mode === "real"
			? Object.fromEntries([
					["OMP_GUI_OMP", undefined],
					// A provider key in this shell would make a provider serve: a first-time user has none.
					...Object.keys(process.env)
						.filter(key => /_API_KEY$|_TOKEN$/.test(key))
						.map(key => [key, undefined] as const),
				])
			: { OMP_GUI_OMP: omp, OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_SIGNED_OUT: "1" };
	let download: DownloadServer | null = null;
	if (installing) {
		await fs.rename(omp, `${omp}.staged`);
		download = await downloadServer();
		Object.assign(env, {
			OMP_GUI_TEST_INSTALLER: await writeFakeOmp(installerDir, INSTALLER),
			OMP_GUI_TEST_DOWNLOAD: download.url,
			OMP_GUI_TEST_DOWNLOAD_SHA256: createHash("sha256").update(DOWNLOAD).digest("hex"),
			OMPDESK_FAKE_INSTALLER_DIR: installerDir,
			OMPDESK_FAKE_OMP: omp,
		});
	}
	const app = await launchApp({ project, desktop, agent, profile: root, env });
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await recordTrouble(page);
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	return {
		app,
		page,
		root,
		desktop,
		errors,
		finishDownload: () => download?.finish(),
		close: async () => {
			await exitApp(app);
			download?.finish();
			download?.server.close();
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		},
	};
}

/**
 * Watches the whole page from as early as the test can reach it: every error a
 * first-time user could see in the sidebar or the title bar (an alert, a danger
 * badge, the failed-load and omp-unavailable wording), anywhere outside the
 * setup screen, and every toast. Each one lands in `window.__trouble` once.
 */
async function recordTrouble(page: Page): Promise<void> {
	await page.evaluate(() => {
		const seen = new Set<string>();
		const trouble: string[] = [];
		window.__trouble = trouble;
		const note = (entry: string) => {
			if (seen.has(entry)) return;
			seen.add(entry);
			trouble.push(entry);
		};
		const WORDING =
			/Couldn't load sessions|세션을 불러오지 못했어요|stock helper|omp unavailable|omp를 사용할 수 없어요|omp not found|OMP_GUI_OMP points|isn't connected|연결되지 않았어요/;
		const STATUS = /^(Error|Exited|오류|종료됨)$/;
		const scan = () => {
			const takeover = document.querySelector('[data-testid="setup-takeover"]');
			const outside = (element: Element) => !takeover?.contains(element);
			for (const region of document.querySelectorAll(".omp-session-sidebar, .omp-titlebar")) {
				const where = region.classList.contains("omp-titlebar") ? "title bar" : "sidebar";
				for (const alert of region.querySelectorAll('[role="alert"]')) note(`${where} alert: ${alert.textContent}`);
				for (const badge of region.querySelectorAll(".omp-titlebar-status-label")) {
					if (STATUS.test(badge.textContent?.trim() ?? "")) note(`${where} status: ${badge.textContent}`);
				}
				const text = region.textContent ?? "";
				const match = WORDING.exec(text);
				if (match) note(`${where} text: ${match[0]}`);
			}
			for (const alert of document.querySelectorAll('[role="alert"]')) {
				if (outside(alert) && WORDING.test(alert.textContent ?? "")) note(`alert: ${alert.textContent}`);
			}
			for (const toast of document.querySelectorAll("[data-toast-stack] > *")) note(`toast: ${toast.textContent}`);
		};
		scan();
		new MutationObserver(scan).observe(document.documentElement, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["role", "class"],
		});
	});
}

async function trouble(page: Page): Promise<string[]> {
	return page.evaluate(() => window.__trouble ?? ["recorder missing"]);
}

async function release(launched: Launched, attempt: number): Promise<void> {
	await fs.writeFile(path.join(launched.root, "installer", `go-${attempt}`), "");
}

/** The startup marks of this launch (`source: "startup-timing"`), mark → ms since main started. */
async function startupMarks(launched: Launched): Promise<Record<string, number>> {
	const text = await fs.readFile(path.join(launched.desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => "");
	const marks: Record<string, number> = {};
	for (const line of text.split("\n").filter(Boolean)) {
		const entry = JSON.parse(line) as { source?: string; message?: string; details?: { sinceLaunchMs?: number } };
		if (entry.source !== "startup-timing" || !entry.message) continue;
		if (typeof entry.details?.sinceLaunchMs === "number") marks[entry.message] = entry.details.sinceLaunchMs;
	}
	return marks;
}

async function report(launched: Launched, label: string, extra: Record<string, number> = {}): Promise<void> {
	await expect.poll(async () => (await startupMarks(launched))["first-run-visible"]).toBeGreaterThan(0);
	const marks = { ...(await startupMarks(launched)), ...extra };
	const line = `[first-run timing] ${label} ${process.platform}: ${JSON.stringify(marks)}`;
	console.log(line);
	const body = JSON.stringify({ label, platform: process.platform, marks }, null, 2);
	// A file in test-results too: CI uploads that folder, and the line above lands in its log.
	await fs.writeFile(test.info().outputPath("timing.json"), body);
	await test.info().attach("timing.json", { body });
}

for (const language of variants(["en", "ko"] as const)) {
	for (const theme of variants(["light", "dark"] as const)) {
		test(`first-run: no errors while omp is missing or installing; the provider step follows (${language} ${theme})`, async () => {
			test.setTimeout(120_000);
			const launched = await launch(`${language}-${theme}`, language, theme, "installing");
			const { page } = launched;
			try {
				const takeover = page.getByTestId("setup-takeover");
				const omp = page.locator('[data-testid="machine-setup"] [data-setup-item="omp"]');
				// Held mid-install: the download stops at half.
				await expect(omp).toHaveAttribute("data-phase", "running", { timeout: 30_000 });
				await expect(omp.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0.5");
				// Long enough for every early read (session list, usage, status) to have answered.
				await page.waitForTimeout(2_000);
				await capture(page, `installing-${language}-${theme}`);
				expect(await trouble(page)).toEqual([]);

				// The first attempt fails: the setup screen says why, nothing else does.
				launched.finishDownload();
				await release(launched, 1);
				await expect(omp).toHaveAttribute("data-phase", "failed", { timeout: 30_000 });
				await page.waitForTimeout(1_000);
				await capture(page, `failed-${language}-${theme}`);
				expect(await trouble(page)).toEqual([]);

				// The retry installs omp: the tab starts on its own and the provider step shows.
				await page.getByTestId("setup-retry").first().click();
				await expect(omp).toHaveAttribute("data-phase", "running");
				await release(launched, 2);
				const step = page.locator('[data-first-run-step="connect"]');
				await expect(step).toBeVisible({ timeout: 30_000 });
				await expect(takeover).toHaveCount(0);
				await expect(step.locator("[data-provider-picker]")).toBeVisible();
				// Late toasts (bridge health, usage) would land in this window.
				await page.waitForTimeout(2_000);
				await capture(page, `provider-step-${language}-${theme}`);
				expect(await trouble(page)).toEqual([]);
				expect(launched.errors).toEqual([]);
				const marks = await startupMarks(launched);
				expect(marks["omp-ready"]).toBeGreaterThan(0);
				await report(launched, `after setup (${language} ${theme})`, {
					setupToWizardMs: (marks["first-run-visible"] ?? 0) - (marks["omp-ready"] ?? 0),
				});
			} finally {
				await launched.close();
			}
		});
	}
}

test("first-run: wizard timing, launch with omp present → provider step", async () => {
	const launched = await launch("timing", "en", "dark", "present");
	try {
		await expect(launched.page.locator('[data-first-run-step="connect"]')).toBeVisible({ timeout: 30_000 });
		await report(launched, "launch");
		expect(await trouble(launched.page)).toEqual([]);
	} finally {
		await launched.close();
	}
});

/**
 * Opt-in (`OMP_GUI_REAL_FIRST_START=1`): the real boot cost of the user's installed omp on a fresh agent
 * dir, which the fake omp cannot show (its bundle load, cold provider discovery, a virus scan).
 */
test("first-run: wizard timing on the real omp (fresh agent dir)", async () => {
	test.skip(process.env.OMP_GUI_REAL_FIRST_START !== "1", "set OMP_GUI_REAL_FIRST_START=1 to measure the real omp");
	test.setTimeout(120_000);
	const launched = await launch("real", "en", "dark", "real");
	try {
		await expect(launched.page.locator('[data-first-run-step="connect"]')).toBeVisible({ timeout: 60_000 });
		await expect(launched.page.locator("[data-provider-picker]")).toBeVisible({ timeout: 60_000 });
		await expect
			.poll(async () => (await startupMarks(launched))["sidecar-ready"], { timeout: 60_000 })
			.toBeGreaterThan(0);
		await report(launched, "real omp launch");
		// No credential anywhere: the provider step is up while omp still boots, not after it.
		const marks = await startupMarks(launched);
		expect(marks["first-run-visible"]).toBeLessThan(marks["sidecar-ready"] ?? 0);
	} finally {
		await launched.close();
	}
});
