import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp, untilAnswered } from "./harness";

// While memory is short, a quiet session gives its omp back and starts again on its session when it is shown
// (src/main/idle-release.ts, SidecarPool.releaseIdle). The decision is unit-tested in idle-release.test.ts and the
// pool's checks in sidecar-pool.test.ts; this spec runs the real wiring on the fake omp: memory from
// OMP_GUI_TEST_MEMORY, quiet time OMP_GUI_TEST_IDLE_RELEASE_MS, the tab status every view reads, the transcript.

test("a quiet hidden session is released only while memory is short, and comes back with its conversation", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-idle-release-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	const memory = path.join(profile, "memory.json");
	const setMemory = (availableGb: number) =>
		fs.writeFile(memory, JSON.stringify({ totalGb: 16, availableGb, pressure: "normal" }));
	await setMemory(8);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_SESSION_FILES: "1",
			OMP_GUI_TEST_BACKGROUND_JOB: "1",
			OMP_GUI_TEST_MEMORY: memory,
			OMP_GUI_TEST_MEMORY_MS: "200",
			OMP_GUI_TEST_IDLE_RELEASE_MS: "1000",
		},
	});
	const errors: string[] = [];
	try {
		const page = await app.firstWindow();
		page.on("pageerror", error => errors.push(error.message));
		await page.waitForFunction(() => window.omp?.rpc != null);
		const status = async (id: string) =>
			(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === id)?.status;
		const transcript = (id: string) =>
			page.evaluate(
				async id =>
					(
						(await window.omp.rpc.commandForTab(id, { type: "get_transcript_page", fromEnd: true, limit: 50 }))
							.data as { messages?: unknown[] }
					)?.messages ?? [],
				id,
			);
		const shown = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		await expect.poll(() => status(shown)).toBe("ready");
		await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), shown);
		await untilAnswered(page, shown);

		// Two background sessions with a turn each: one done, one whose subagent still works.
		const spawn = async () => {
			const tabId =
				(await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project))?.tabId ?? "";
			await expect.poll(() => status(tabId)).toBe("ready");
			return tabId;
		};
		const quiet = await spawn();
		await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), quiet);
		await untilAnswered(page, quiet);
		const working = await spawn();
		await page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture background subagent" }),
			working,
		);
		const before = await transcript(quiet);
		expect(before.length).toBeGreaterThan(0);

		// Memory is fine: nothing changes, however long they are quiet.
		await delay(2_500);
		expect([await status(shown), await status(quiet), await status(working)]).toEqual(["ready", "ready", "running"]);

		// Short: the quiet hidden one goes; the one shown and the one whose subagent works stay.
		await setMemory(1.5);
		await expect.poll(() => status(quiet), { timeout: 15_000 }).toBe("asleep");
		await delay(2_000);
		expect([await status(shown), await status(working)]).toEqual(["ready", "running"]);
		const log = await fs.readFile(path.join(desktop, "logs", "gui-runtime.jsonl"), "utf8");
		expect(log).toContain('"memory release"');

		// Shown again (the person clicks its sidebar row): its conversation is on screen at once, and its omp starts on
		// its session.
		await setMemory(8);
		const file = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === quiet)?.sessionPath;
		expect(file).toBeTruthy();
		await page.locator(`[data-session-path="${file}"] button[data-roving-item]`).click();
		await expect(
			page.locator(`.omp-session-pane[data-tab-id="${quiet}"] [data-transcript-kind]`).first(),
		).toBeVisible({ timeout: 1_000 });
		await expect.poll(() => status(quiet), { timeout: 15_000 }).toBe("ready");
		expect(await transcript(quiet)).toEqual(before);
		await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello again" }), quiet);
		await untilAnswered(page, quiet, { after: "hello again" });
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
