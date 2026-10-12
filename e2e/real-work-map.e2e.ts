import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createToolsStore } from "../src/renderer/stores/tools";
import type { SubagentFrame } from "../src/shared/rpc-types";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";
import type { RecordedWorkFrame } from "./work-recording";

// Explicit opt-in: this audit spends model tokens and copies credentials only
// into a private disposable directory. Ordinary test runs never make calls.
test("real omp 18.8.7 streams inline subagent tools", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(300_000);
	const evidenceDir = process.env.OMP_GUI_REAL_WORK_ARTIFACTS ?? path.join(os.tmpdir(), "ompdesk-real-work-evidence");
	await fs.mkdir(evidenceDir, { recursive: true });
	const { profile, project, desktop, env } = await realOmpProfile();
	await fs.writeFile(path.join(project, "alpha.txt"), "alpha\nbeta\ngamma\n");
	await fs.writeFile(path.join(project, "beta.txt"), "one\ntwo\n");
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
			const observed: SubagentFrame[] = [];
			const recording: RecordedWorkFrame[] = [];
			const started = performance.now();
			Object.assign(window, { __realWorkFrames: observed, __realWorkRecording: recording });
			window.omp.events.onTabSubagentFrame(frame => {
				observed.push(frame);
				recording.push({ atMs: performance.now() - started, channel: "subagent", frame });
			});
			window.omp.events.onTabBatch(events =>
				recording.push({ atMs: performance.now() - started, channel: "main", events }),
			);
		});
		const input = page.locator("textarea").first();
		await input.fill(
			"Use the task tool exactly once to start TWO general-purpose task agents in parallel, named AlphaCounter and BetaCounter, using @smol. Do not use scout agents: they have no bash tool. Each agent runs exactly one bash command in the workspace root: AlphaCounter runs `sleep 3 && wc -l alpha.txt`; BetaCounter runs `sleep 3 && wc -l beta.txt`. Each reports its line count in a one-sentence result summary. Wait for both and report both line counts. Do not edit files, do not call an advisor, do not investigate anything else.",
		);
		await input.press("Enter");
		await expect(page.locator(".omp-work-card-button")).toHaveCount(2, { timeout: 120_000 });
		await page.screenshot({
			path: path.join(evidenceDir, "real-work-running.png"),
			animations: "disabled",
			scale: "css",
		});
		await page.locator(".omp-work-card-button").first().click();
		const liveSurface = page.locator('.omp-work-card[data-open="true"] .omp-live-step').first();
		await expect(liveSurface).toBeVisible({ timeout: 120_000 });
		await page.screenshot({
			path: path.join(evidenceDir, "real-work-expanded-live.png"),
			animations: "disabled",
			scale: "css",
		});
		// Replay the completed command when its brief live step already advanced to yield.
		const bashStep = liveSurface.getByRole("button", { name: /Run command/ }).first();
		await expect(bashStep).toBeVisible({ timeout: 120_000 });
		await bashStep.click();
		await expect(liveSurface).toHaveAttribute("data-surface", "bash");
		await page.screenshot({
			path: path.join(evidenceDir, "real-work-expanded.png"),
			animations: "disabled",
			scale: "css",
		});
		await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0, { timeout: 180_000 });
		await expect(page.locator(".omp-work-outcome")).toBeVisible();
		await page.locator(".omp-work-outcome summary").click();
		await page.screenshot({
			path: path.join(evidenceDir, "real-work-complete.png"),
			animations: "disabled",
			scale: "css",
		});
		const observed = await page.evaluate(() => {
			// This field was installed by this audit, not by a remote payload.
			const auditWindow = window as unknown as { __realWorkFrames: SubagentFrame[] };
			return auditWindow.__realWorkFrames;
		});
		await fs.writeFile(path.join(evidenceDir, "real-work-frames.json"), JSON.stringify(observed, null, 2));
		expect(observed.some(frame => frame.type === "subagent_event")).toBe(true);
	} finally {
		const frames = await app
			.firstWindow()
			.then(page =>
				page.evaluate(() => {
					const auditWindow = window as unknown as { __realWorkFrames?: SubagentFrame[] };
					return auditWindow.__realWorkFrames ?? [];
				}),
			)
			.catch(() => []);
		await fs.writeFile(path.join(evidenceDir, "real-work-frames.json"), JSON.stringify(frames, null, 2));
		const recording = await app
			.firstWindow()
			.then(page =>
				page.evaluate(
					() => (window as unknown as { __realWorkRecording?: RecordedWorkFrame[] }).__realWorkRecording ?? [],
				),
			)
			.catch(() => []);
		await fs.writeFile(path.join(evidenceDir, "real-work-recording.json"), JSON.stringify(recording, null, 2));
		const tools = createToolsStore();
		for (const frame of recording) if (frame.channel === "main") tools.getState().applyEvents(frame.events);
		await fs.writeFile(
			path.join(evidenceDir, "real-work-tools.json"),
			JSON.stringify(
				{
					source: "ToolsStore reconstructed from captured main batches",
					finished: [...tools.getState().finishedTools.values()],
					live: [...tools.getState().liveTools.values()],
				},
				null,
				2,
			),
		);
		await app
			.firstWindow()
			.then(page =>
				page.screenshot({
					path: path.join(evidenceDir, "real-work-final.png"),
					animations: "disabled",
					scale: "css",
				}),
			)
			.catch(() => undefined);
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
