/**
 * Opt-in (`OMP_GUI_REAL_STARTUP=<dir>`): how long the built app takes, on the user's installed omp, from launch to a
 * usable window and from opening a long session to its transcript and a composer that sends. A private copy of the
 * user's agent dir (config, MCP, extensions, agents, commands; the databases through `VACUUM INTO`) and of their two
 * largest recent sessions; nothing of `~/.omp` is written. No model is called.
 *
 * Per run, in milliseconds:
 * - launch (a relaunch restoring the long session's tab): main's startup marks (`src/shared/startup-timing.ts`, since
 *   main started) and the window's boot skeleton, React layout, first transcript row and composer (`loading-probe.ts`,
 *   since the app was spawned);
 * - open: the second session opened in a background tab of the running app (`tabs.spawn`) and switched to at once
 *   (⌘PageDown, the strip's next tab), with no transcript snapshot (`openCold`) and with one (`openWarm`): from the
 *   switch, its first visible row in the active pane (`Row`), and from the spawn, its tab `ready` (`Ready`).
 *
 * `OMP_GUI_REAL_STARTUP_SUBJECTS=before=<root>,after=<root>` compares built checkouts (each with `out/` and
 * `resources/`; default `after=<cwd>`), their runs interleaved; `OMP_GUI_REAL_STARTUP_RUNS` (default 5). Writes
 * `results.json` and `summary.md` (median and range) to the dir. The no-spinner rules themselves are
 * `no-loading.e2e.ts`'s.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { LOADING_PROBE, readLoading } from "./loading-probe";

const OUT = process.env.OMP_GUI_REAL_STARTUP;
const RUNS = Number(process.env.OMP_GUI_REAL_STARTUP_RUNS ?? 5);
const SUBJECTS = (process.env.OMP_GUI_REAL_STARTUP_SUBJECTS ?? `after=${process.cwd()}`).split(",").map(entry => {
	const [name, root] = entry.split("=");
	return { name: name as string, root: path.resolve(root as string) };
});
const HOME_AGENT = path.join(os.homedir(), ".omp/agent");
const MAIN_MARKS = [
	"app-ready",
	"window-created",
	"renderer-mounted",
	"omp-resolved",
	"omp-spawned",
	"bridge-connected",
	"sidecar-ready",
] as const;

type Numbers = Record<string, number | null>;

/** The two largest sessions written in the last week whose folder still exists: what a long session opens. */
async function longSessions(): Promise<Array<{ file: string; cwd: string }>> {
	const root = path.join(HOME_AGENT, "sessions");
	const found: Array<{ file: string; size: number; cwd: string }> = [];
	const weekAgo = Date.now() - 7 * 24 * 3600_000;
	for (const dir of await fs.readdir(root)) {
		for (const name of await fs.readdir(path.join(root, dir)).catch(() => [])) {
			if (!name.endsWith(".jsonl")) continue;
			const file = path.join(root, dir, name);
			const stat = await fs.stat(file);
			if (stat.mtimeMs < weekAgo || stat.size < 1_000_000) continue;
			const handle = await fs.open(file);
			const { buffer, bytesRead } = await handle.read(Buffer.alloc(65_536), 0, 65_536, 0);
			await handle.close();
			const header = buffer
				.toString("utf8", 0, bytesRead)
				.split("\n")
				.slice(0, 2)
				.flatMap(line => {
					try {
						return [JSON.parse(line) as { type?: string; cwd?: string }];
					} catch {
						return [];
					}
				})
				.find(entry => entry.type === "session");
			const cwd = header?.cwd;
			if (cwd && (await fs.stat(cwd).catch(() => null))?.isDirectory()) found.push({ file, size: stat.size, cwd });
		}
	}
	return found.sort((a, b) => b.size - a.size).slice(0, 2);
}

interface Profile {
	root: string;
	desktop: string;
	env: Record<string, string>;
	sessions: Array<{ file: string; cwd: string }>;
}

async function makeProfile(name: string, sessions: Array<{ file: string; cwd: string }>): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-real-startup-${name}-`)));
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent, { mode: 0o700 })]);
	for (const entry of ["config.yml", "mcp.json", "AGENTS.md", "extensions", "agents", "commands"]) {
		await fs.cp(path.join(HOME_AGENT, entry), path.join(agent, entry), { recursive: true }).catch(() => undefined);
	}
	for (const db of ["agent", "models", "history", "skill-descriptions"]) {
		const source = path.join(HOME_AGENT, `${db}.db`);
		if (await fs.stat(source).catch(() => null))
			execFileSync("sqlite3", [source, `VACUUM INTO '${path.join(agent, `${db}.db`).replaceAll("'", "''")}'`]);
	}
	const copies = [];
	for (const session of sessions) {
		const file = path.join(agent, "sessions", path.basename(path.dirname(session.file)), path.basename(session.file));
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.copyFile(session.file, file);
		copies.push({ file, cwd: session.cwd });
	}
	const [first] = copies;
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			tabLayouts: [
				{ version: 1, tabs: [{ cwd: first?.cwd, sessionPath: first?.file, kind: "agent" }], activeIndex: 0 },
			],
		}),
	);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_HEADLESS: "1",
	});
	for (const key of ["ELECTRON_RUN_AS_NODE", "OMP_GUI_OMP"]) Reflect.deleteProperty(env, key);
	return { root, desktop, env, sessions: copies };
}

/**
 * Opens `payload` in a background tab and switches to it at once (⌘PageDown: two tabs, so the next one is it).
 * `rowMs`: from the switch until the active pane, now that tab's, shows a transcript row; `readyMs`: from the spawn
 * until the tab is `ready`.
 */
async function untilUsable(
	page: Page,
	payload: { cwd: string; sessionPath: string },
): Promise<{ rowMs: number | null; readyMs: number | null }> {
	const tabId = await page.evaluate(async spawn => {
		const watch = { t0: performance.now(), switchedAt: null as number | null, rowAt: null as number | null };
		window.__switch = watch;
		const id = (await window.omp.tabs.spawn(spawn))?.tabId ?? null;
		const frame = () => {
			const pane = document.querySelector(`section[data-active="true"][data-tab-id="${id}"]`);
			for (const el of pane?.querySelectorAll("[data-transcript-kind]") ?? []) {
				const box = el.getBoundingClientRect();
				if (box.width > 0 && box.height > 0) {
					watch.rowAt = performance.now();
					return;
				}
			}
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
		watch.switchedAt = performance.now();
		return id;
	}, payload);
	expect(tabId, "the session did not open a tab").not.toBeNull();
	await page.keyboard.press(process.platform === "darwin" ? "Meta+PageDown" : "Control+PageDown");
	return page.evaluate(async id => {
		const watch = window.__switch;
		if (!watch) return { rowMs: null, readyMs: null };
		let readyMs: number | null = null;
		while (readyMs === null && performance.now() - watch.t0 < 60_000) {
			const tab = (await window.omp.tabs.list()).find(entry => entry.tabId === id);
			if (tab?.status === "ready") readyMs = performance.now() - watch.t0;
			else await new Promise(resolve => setTimeout(resolve, 10));
		}
		while (watch.rowAt === null && performance.now() - watch.t0 < 60_000)
			await new Promise(resolve => setTimeout(resolve, 10));
		return {
			rowMs: watch.rowAt === null || watch.switchedAt === null ? null : watch.rowAt - watch.switchedAt,
			readyMs,
		};
	}, tabId);
}

declare global {
	interface Window {
		/** `untilUsable`'s switch: when the spawn began, when the switch was pressed, when its pane first showed a row. */
		__switch?: { t0: number; switchedAt: number | null; rowAt: number | null };
	}
}

/** The startup marks main wrote in this launch (its pid), ms since main started. */
async function mainMarks(desktop: string, pid: number): Promise<Numbers> {
	const text = await fs.readFile(path.join(desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => "");
	const marks: Numbers = Object.fromEntries(MAIN_MARKS.map(mark => [mark, null]));
	for (const line of text.split("\n").filter(Boolean)) {
		const entry = JSON.parse(line) as {
			pid?: number;
			source?: string;
			message?: string;
			details?: { sinceLaunchMs?: number };
		};
		if (entry.pid !== pid || entry.source !== "startup-timing" || !entry.message) continue;
		if (entry.message in marks && typeof entry.details?.sinceLaunchMs === "number")
			marks[entry.message] = entry.details.sinceLaunchMs;
	}
	return marks;
}

async function launch(
	root: string,
	profile: Profile,
): Promise<{ app: ElectronApplication; page: Page; spawnedAt: number }> {
	const spawnedAt = Date.now();
	const app = await electron.launch({
		args: [path.join(root, "out/main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	await app.context().addInitScript(LOADING_PROBE);
	const page = await app.firstWindow();
	if (!(await page.evaluate(() => window.__nl !== undefined))) await page.reload();
	await page.waitForFunction(() => window.omp?.tabs != null);
	return { app, page, spawnedAt };
}

async function untilReady(page: Page): Promise<void> {
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).some(tab => tab.status === "ready"), {
			timeout: 90_000,
		})
		.toBe(true);
	await expect(page.locator("[data-transcript-kind]").first()).toBeVisible({ timeout: 60_000 });
}

async function measure(root: string, profile: Profile): Promise<Numbers> {
	const { app, page, spawnedAt } = await launch(root, profile);
	try {
		await untilReady(page);
		await page.waitForTimeout(1500);
		const reading = await readLoading(page);
		const sinceSpawn = (t: number | null) => (t === null ? null : Math.round(reading.timeOrigin + t - spawnedAt));
		const numbers: Numbers = {
			...(await mainMarks(profile.desktop, app.process().pid ?? -1)),
			bootPaint: sinceSpawn(reading.bootAt),
			shellPaint: sinceSpawn(reading.shellAt),
			firstRow: sinceSpawn(reading.rowAt),
			composer: sinceSpawn(reading.composerAt),
		};
		const second = profile.sessions[1];
		if (second) {
			const open = { cwd: second.cwd, sessionPath: second.file };
			const close = () =>
				page.evaluate(async file => {
					const tab = (await window.omp.tabs.list()).find(entry => entry.sessionPath === file);
					if (tab) await window.omp.tabs.close(tab.tabId);
				}, second.file);
			// A session never shown here: no tab holds it and no transcript snapshot, the rows come from its omp.
			await close();
			await page.evaluate(() => {
				for (const key of Object.keys(localStorage))
					if (key.startsWith("omp.snap.") && key.includes(".transcript.")) localStorage.removeItem(key);
			});
			await page.waitForTimeout(1500);
			const cold = await untilUsable(page, open);
			numbers.openColdRow = cold.rowMs === null ? null : Math.round(cold.rowMs);
			numbers.openColdReady = cold.readyMs === null ? null : Math.round(cold.readyMs);
			// Close it and open it again: the snapshot written meanwhile paints first.
			await page.waitForTimeout(4500);
			await close();
			await page.waitForTimeout(1500);
			const warm = await untilUsable(page, open);
			numbers.openWarmRow = warm.rowMs === null ? null : Math.round(warm.rowMs);
			numbers.openWarmReady = warm.readyMs === null ? null : Math.round(warm.readyMs);
			// The next launch restores the long session's tab alone, as the first did.
			await close();
			await page.waitForTimeout(500);
		}
		return numbers;
	} finally {
		await exitApp(app);
	}
}

function summary(results: Record<string, Numbers[]>): string {
	const keys = [...new Set(Object.values(results).flatMap(runs => runs.flatMap(run => Object.keys(run))))];
	const names = Object.keys(results);
	const lines = [`| ms | ${names.join(" | ")} |`, `|---|${names.map(() => "---").join("|")}|`];
	for (const key of keys) {
		const cells = names.map(name => {
			const values = (results[name] ?? []).map(run => run[key]).filter((v): v is number => typeof v === "number");
			if (values.length === 0) return "–";
			const sorted = [...values].sort((a, b) => a - b);
			return `${sorted[Math.floor(sorted.length / 2)]} (${sorted[0]}–${sorted.at(-1)})`;
		});
		lines.push(`| ${key} | ${cells.join(" | ")} |`);
	}
	return `${lines.join("\n")}\n`;
}

async function measureStartup(dir: string): Promise<void> {
	test.setTimeout(60 * 60_000);
	const sessions = await longSessions();
	expect(sessions.length, "no session over 1 MB written this week").toBeGreaterThan(0);
	const profiles = new Map<string, Profile>();
	const results: Record<string, Numbers[]> = {};
	try {
		for (const subject of SUBJECTS) {
			const profile = await makeProfile(subject.name, sessions);
			profiles.set(subject.name, profile);
			results[subject.name] = [];
			// A first launch writes what the measured relaunches paint from (snapshots, the layout) and warms omp.
			const { app, page } = await launch(subject.root, profile);
			try {
				await untilReady(page);
				await page.waitForTimeout(5000);
			} finally {
				await exitApp(app);
			}
		}
		for (let run = 0; run < RUNS; run++) {
			for (const subject of SUBJECTS) {
				const profile = profiles.get(subject.name) as Profile;
				const numbers = await measure(subject.root, profile);
				results[subject.name]?.push(numbers);
				console.log(`[real startup] ${subject.name} run ${run + 1}: ${JSON.stringify(numbers)}`);
			}
		}
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(results, null, 2));
		const table = summary(results);
		await fs.writeFile(path.join(dir, "summary.md"), table);
		console.log(table);
	} finally {
		for (const profile of profiles.values())
			await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

// Registered only with its dir set (Playwright runs with `--pass-with-no-tests`).
if (OUT) test("real omp: launch to a usable window and a long session's open, per phase", () => measureStartup(OUT));
