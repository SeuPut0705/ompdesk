import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";
import type { RecordedWorkFrame } from "./work-recording";

// Explicit opt-in: this audit spends model tokens (the user's `smol` role, plus the
// `advisor` role stock's advisor runs on) and copies credentials only into a private
// disposable directory. Ordinary test runs never make calls.
//
// Stock's advisor watches the turn and files notes as a `customType: "advisor"`
// message. Whatever the notes say, a note the session persisted is on screen while the
// turn runs, not only after the transcript is reloaded.
test("real omp advisor note appears live and is recorded", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(600_000);
	const evidenceDir = process.env.OMP_GUI_REAL_WORK_ARTIFACTS ?? path.join(os.tmpdir(), "ompdesk-real-advisor");
	await fs.mkdir(evidenceDir, { recursive: true });
	const { profile, project, desktop, env } = await realOmpProfile();
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		await page.evaluate(() => {
			const recording: RecordedWorkFrame[] = [];
			const started = performance.now();
			Object.assign(window, { __realAdvisorRecording: recording });
			window.omp.events.onTabBatch(events =>
				recording.push({ atMs: performance.now() - started, channel: "main", events }),
			);
		});
		const tab = (await page.evaluate(() => window.omp.tabs.list())).find(row => row.active);
		if (!tab) throw new Error("No advisor tab");
		const input = page.locator("textarea").first();
		// The turns that made stock's advisor speak in the scenario audit: a todo list left open (the
		// reminder it earns is itself advisable), then an unrelated failing command.
		for (const prompt of [
			"Create the file notes.txt containing exactly the line alpha. Then use the edit tool to change alpha to beta. Then reply in one sentence.",
			"Use your todo tool to create a list with three tasks: Read, Count, Report. Mark Read in progress, run the bash command `ls`, mark Read completed and Count in progress, run `wc -l notes.txt`, then stop and reply in one sentence. Leave Count and Report open.",
			"Run the bash command `exit 3` exactly once. Do not retry and do not run anything else. Reply in one sentence.",
		]) {
			await input.fill(prompt);
			await input.press("Enter");
			await expect(page.getByPlaceholder(/Add an instruction/)).toBeVisible({ timeout: 60_000 });
			await expect(page.getByPlaceholder(/Ask anything ·/)).toBeVisible({ timeout: 300_000 });
		}
		const sessionPath = (await page.evaluate(() => window.omp.tabs.list())).find(
			row => row.tabId === tab.tabId,
		)?.sessionPath;
		if (!sessionPath) throw new Error("The tab has no session file");
		// The advisor files its note after the turn it watched; give it time to speak.
		const persistedNotes = async () =>
			(await fs.readFile(sessionPath, "utf8")).split("\n").filter(line => line.includes('"customType":"advisor"'))
				.length;
		await expect
			.poll(persistedNotes, { timeout: 180_000, intervals: [2_000] })
			.toBeGreaterThan(0)
			.catch(() => undefined);
		const notes = await persistedNotes();
		await page.waitForTimeout(3_000);
		const recording = await page.evaluate(() => Reflect.get(window, "__realAdvisorRecording") as RecordedWorkFrame[]);
		await fs.writeFile(path.join(evidenceDir, "advisor-frames.json"), JSON.stringify(recording, null, 2));
		await fs.copyFile(sessionPath, path.join(evidenceDir, "session.jsonl"));
		test.skip(notes === 0, "The advisor filed no note on this run");
		// The wire commits every custom message the run delivered (an advisor card, a job result) with
		// the journal entry id the renderer reconciles it by: a committed message without one is dropped
		// from the live transcript when the run ends, and only a reload brings it back.
		const committed = recording
			.flatMap(frame => (frame.channel === "main" ? frame.events : []))
			.flatMap(event => (event.type === "agent_end" ? (event.messages ?? []) : []))
			.filter(message => message.role === "custom");
		expect(committed.filter(message => message.entryId === undefined)).toEqual([]);
		// Every note stock persisted has a card in the live transcript.
		await expect
			.poll(() => page.locator('[data-transcript-kind="message"][data-row-key^="message-custom-"]').count())
			.toBeGreaterThanOrEqual(notes);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
