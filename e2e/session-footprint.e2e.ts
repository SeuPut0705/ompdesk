import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import {
	appTree,
	detachedWorkers,
	type PhaseSummary,
	type Report,
	type Sample,
	samplePs,
	summarize,
	type Tree,
	withFootprints,
} from "../scripts/session-footprint";
import { exitApp, launchApp } from "./harness";

// Opt-in benchmark (`bun scripts/session-footprint.ts run`): what the app and each session cost in RSS and CPU, at
// idle, while streaming, after visiting every tab and on a long transcript, with the fake omp for scale and a few
// real omp (the system omp, no credentials: it boots on its catalog model and never calls one).
const OUT = process.env.OMP_GUI_FOOTPRINT_OUT;
const FAKE = Number(process.env.OMP_GUI_FOOTPRINT_FAKE ?? 20);
const REAL = Math.min(3, Number(process.env.OMP_GUI_FOOTPRINT_REAL ?? 2));
const SAMPLE_EVERY_MS = 1_000;
const IDLE_MS = 12_000;

interface Run {
	app: ElectronApplication;
	page: Page;
	mainPid: number;
	baseline: Sample;
}

async function profile(name: string) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `ompdesk-footprint-${name}-`));
	const dirs = {
		profile: root,
		project: path.join(root, "project"),
		desktop: path.join(root, "desktop"),
		agent: path.join(root, "agent"),
	};
	await Promise.all([dirs.project, dirs.desktop, dirs.agent].map(dir => fs.mkdir(dir, { recursive: true })));
	await fs.writeFile(
		path.join(dirs.desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true }),
	);
	// The steady state: REA starts at a session's first REA call once its answers are cached (builtin-packs.md › REA
	// starts at first use). A fresh profile has no cache, so its first launch starts REA (~270 MB) with the session.
	const reaCache = path.join(os.homedir(), "Library/Application Support/ompdesk/rea");
	if (process.platform === "darwin")
		await fs.cp(reaCache, path.join(dirs.desktop, "rea"), { recursive: true }).catch(() => undefined);
	return dirs;
}

async function start(
	name: string,
	env: Record<string, string | undefined> = {},
): Promise<Run & { project: string; agent: string }> {
	const dirs = await profile(name);
	const baseline = samplePs();
	const app = await launchApp({ ...dirs, env });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await allReady(page, 1);
	return { app, page, mainPid: app.process().pid ?? 0, baseline, project: dirs.project, agent: dirs.agent };
}

/** A saved session in `cwd` with one user turn and one `!` run (no model named: a credential-less omp opens it). */
async function seedSession(agent: string, cwd: string, index: number): Promise<string> {
	const file = path.join(agent, "sessions", "footprint", `seeded-${index}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const at = new Date().toISOString();
	const entries = [
		{ type: "session", version: 3, id: crypto.randomUUID(), timestamp: at, cwd },
		{
			type: "message",
			id: "seed0001",
			parentId: null,
			timestamp: at,
			message: { role: "user", content: [{ type: "text", text: `session ${index}` }], timestamp: Date.now() },
		},
		{
			type: "message",
			id: "seed0002",
			parentId: "seed0001",
			timestamp: at,
			message: {
				role: "bashExecution",
				command: "printf ok",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
			},
		},
	];
	await fs.writeFile(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

async function allReady(page: Page, count: number, timeout = 120_000): Promise<void> {
	await expect
		.poll(
			async () => (await page.evaluate(() => window.omp.tabs.list())).filter(tab => tab.status === "ready").length,
			{ timeout, intervals: [100] },
		)
		.toBeGreaterThanOrEqual(count);
}

/** Samples the app's tree every second for `ms` and summarizes it as one phase. */
async function phase(run: Run, name: string, ms = IDLE_MS, notes?: string): Promise<PhaseSummary> {
	const trees: Array<{ at: number; tree: Tree }> = [];
	const end = Date.now() + ms;
	while (true) {
		const sample = samplePs();
		const tree = withFootprints(appTree(sample, run.mainPid, detachedWorkers(run.baseline, sample)));
		trees.push({ at: sample.at, tree });
		if (Date.now() >= end) break;
		await delay(SAMPLE_EVERY_MS);
	}
	const summary = summarize(name, trees, notes);
	console.log(
		`[footprint] ${name}: ${summary.sessions} sessions, total ${Math.round(summary.totalBytes / 2 ** 20)} MB, cpu ${summary.cpuTotal.toFixed(1)}%`,
	);
	return summary;
}

/** Opens a background agent tab and returns how long it took to read ready. */
async function spawnReady(page: Page, cwd: string, sessionPath?: string): Promise<{ tabId: string; ms: number }> {
	const started = performance.now();
	const spawned = await page.evaluate(
		([cwd, sessionPath]) => window.omp.tabs.spawn({ cwd, kind: "agent", ...(sessionPath ? { sessionPath } : {}) }),
		[cwd, sessionPath] as const,
	);
	const tabId = spawned?.tabId ?? "";
	expect(tabId).not.toBe("");
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status, {
			timeout: 120_000,
			intervals: [50],
		})
		.toBe("ready");
	return { tabId, ms: performance.now() - started };
}

test("session footprint: app fixed cost and per-session cost", async () => {
	test.skip(!OUT, "Opt-in benchmark: bun scripts/session-footprint.ts run");
	if (!OUT) return;
	test.setTimeout(1_800_000);
	const phases: PhaseSummary[] = [];
	const restoreMs: Record<string, number[]> = { fake: [], real: [] };

	// Fake omp: the app's own cost and how it grows with the number of sessions.
	{
		const run = await start("fake");
		try {
			phases.push(await phase(run, "fake: 1 session idle"));
			const ids: string[] = [];
			for (let index = 1; index < FAKE; index++) {
				const spawned = await spawnReady(run.page, run.project);
				ids.push(spawned.tabId);
				restoreMs.fake?.push(spawned.ms);
			}
			await allReady(run.page, FAKE);
			phases.push(await phase(run, `fake: ${FAKE} sessions idle`));
			for (const tabId of ids) {
				await run.page.evaluate(id => window.omp.tabs.setActive(id), tabId);
				await delay(250);
			}
			phases.push(await phase(run, `fake: ${FAKE} sessions, all visited`));
			const streaming = ids.slice(0, 5);
			for (const tabId of streaming)
				await run.page.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture stream" }),
					tabId,
				);
			phases.push(await phase(run, `fake: ${FAKE} sessions, 5 streaming`, 10_000));
			for (const tabId of streaming)
				await run.page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "abort" }), tabId);
		} finally {
			await exitApp(run.app);
		}
	}

	// A long transcript in the visible tab, paged back to its start.
	{
		const run = await start("history", { OMP_GUI_TEST_HISTORY: "5000" });
		try {
			const row = run.page.locator("[data-transcript-kind]").last();
			await expect(row).toBeVisible({ timeout: 30_000 });
			await row.hover();
			for (let index = 0; index < 60; index++) {
				await run.page.mouse.wheel(0, -4_000);
				await delay(100);
			}
			phases.push(await phase(run, "fake: 5000-message transcript, scrolled"));
		} finally {
			await exitApp(run.app);
		}
	}

	// Real omp: what a session's own process costs, and what a short spell of memory gives back (idle-release.ts).
	if (REAL > 0) {
		const memory = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-footprint-memory-")), "memory.json");
		const setMemory = (availableGb: number) =>
			fs.writeFile(memory, JSON.stringify({ totalGb: 16, availableGb, pressure: "normal" }));
		await setMemory(12);
		const run = await start("real", {
			OMP_GUI_OMP: undefined,
			OMP_GUI_TEST_MEMORY: memory,
			OMP_GUI_TEST_MEMORY_MS: "500",
			OMP_GUI_TEST_IDLE_RELEASE_MS: "5000",
		});
		const tabs = () => run.page.evaluate(() => window.omp.tabs.list());
		try {
			// Startup work (session index, stats ingest, extension loads) settles first: idle means idle.
			await delay(20_000);
			phases.push(await phase(run, "real: 1 session idle", 20_000));
			// Saved sessions, as a person's open tabs are: one turn each, the shape a credential-less omp can open. The
			// first, new tab closes first, so no more than REAL omps run.
			const fresh = (await tabs())[0]?.tabId ?? "";
			const cwd = await fs.realpath(run.project);
			const seeded: string[] = [];
			for (let index = 1; index <= REAL; index++) {
				const spawned = await spawnReady(run.page, run.project, await seedSession(run.agent, cwd, index));
				restoreMs.real?.push(spawned.ms);
				seeded.push(spawned.tabId);
				if (index === 1) await run.page.evaluate(id => window.omp.tabs.close(id), fresh);
			}
			await allReady(run.page, REAL);
			/** Click the tab's sidebar row: ms until its rows are on screen, and until its omp reads ready. */
			const show = async (tabId: string) => {
				const file = (await tabs()).find(tab => tab.tabId === tabId)?.sessionPath ?? "";
				const started = performance.now();
				await run.page.locator(`[data-session-path="${file}"] button[data-roving-item]`).click();
				await expect(
					run.page.locator(`.omp-session-pane[data-tab-id="${tabId}"] [data-transcript-kind]`).first(),
				).toBeVisible({ timeout: 10_000 });
				const shown = performance.now() - started;
				await expect
					.poll(async () => (await tabs()).find(tab => tab.tabId === tabId)?.status, {
						timeout: 60_000,
						intervals: [50],
					})
					.toBe("ready");
				return { shown, ready: performance.now() - started };
			};
			// The person looks at each session once and stays on the last: the others are hidden with a live omp.
			restoreMs.showLive = [];
			for (const tabId of seeded) restoreMs.showLive.push((await show(tabId)).shown);
			const opened = seeded.slice(0, -1);
			await delay(20_000);
			phases.push(await phase(run, `real: ${REAL} sessions idle`, 20_000));
			// Memory short for a moment: the hidden quiet sessions give their omp back.
			await setMemory(1.5);
			await expect
				.poll(async () => (await tabs()).filter(tab => tab.status === "asleep").length, { timeout: 120_000 })
				.toBe(opened.length);
			await setMemory(12);
			await delay(5_000);
			phases.push(await phase(run, `real: ${REAL} sessions, ${opened.length} released after a short spell`, 20_000));
			// Shown again: its rows paint from the tab's snapshot at once, its omp reads ready after its start.
			restoreMs.showReleased = [];
			restoreMs.readyReleased = [];
			for (const tabId of opened) {
				const { shown, ready } = await show(tabId);
				restoreMs.showReleased.push(shown);
				restoreMs.readyReleased.push(ready);
			}
		} finally {
			await exitApp(run.app);
			await fs.rm(path.dirname(memory), { recursive: true, force: true });
		}
	}

	const report: Report = {
		commit: process.env.OMP_GUI_FOOTPRINT_COMMIT ?? "",
		date: new Date().toISOString(),
		machine: { totalBytes: os.totalmem(), platform: process.platform, arch: process.arch },
		phases,
		restoreMs,
	};
	await fs.mkdir(path.dirname(OUT), { recursive: true });
	await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
});
