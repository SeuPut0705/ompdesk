import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

/**
 * Explicit opt-in audits on the user's small model (`OMP_GUI_REAL_WORK=1`, they spend tokens):
 * the two timers OMPdesk adds around stock on the real omp.
 *
 * - Idle compaction: stock's `compaction.idle*` settings have a timer only in the TUI; the
 *   bridge's copy must call stock `runIdleCompaction()` once the session sat idle past the
 *   timeout with an empty draft, and stock journals the compaction.
 * - Goal time limit: a goal whose OMPdesk limit runs out is paused the way stock's own pause
 *   does it (goal paused, the `goal` tool back out of the tool set, no further continuation).
 */
interface Entry {
	type?: string;
	customType?: string;
	message?: { role?: string; stopReason?: string; content?: unknown };
}

async function entries(file: string): Promise<Entry[]> {
	const text = await fs.readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Entry);
}

async function command<T>(page: Page, tabId: string, body: Record<string, unknown>): Promise<T> {
	const response = await page.evaluate(
		([id, payload]) => window.omp.rpc.commandForTab(id as string, payload as never),
		[tabId, body] as const,
	);
	if (!response.success) throw new Error(`${String(body.type)} failed: ${response.error}`);
	return response.data as T;
}

async function launchReal(): Promise<{ app: ElectronApplication; page: Page; tabId: string; profile: string }> {
	const { profile, project, desktop, env } = await realOmpProfile();
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	await expect
		.poll(() => page.evaluate(() => window.omp?.sidecar.getStatus()), { timeout: 90_000 })
		.toMatchObject({ status: "ready" });
	const tab = (await page.evaluate(() => window.omp.tabs.list())).find(row => row.active);
	if (!tab) throw new Error("No active tab");
	return { app, page, tabId: tab.tabId, profile };
}

async function setSetting(page: Page, pathName: string, value: unknown): Promise<void> {
	const response = await page.evaluate(([key, next]) => window.omp.rpc.setSetting(key as string, next), [
		pathName,
		value,
	] as const);
	expect(response.success, pathName).toBe(true);
}

test("real omp: an idle session compacts through stock once the idle timeout passes", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(600_000);
	const { app, page, tabId, profile } = await launchReal();
	try {
		await setSetting(page, "compaction.idleEnabled", true);
		await setSetting(page, "compaction.idleThresholdTokens", 1);
		await setSetting(page, "compaction.idleTimeoutSeconds", 60);
		const input = page.locator(".omp-composer-input").first();
		for (const word of ["FIRST-IDLE", "SECOND-IDLE"]) {
			await input.fill(`Reply with exactly the word ${word} and nothing else.`);
			await input.press("Enter");
			// The transcript renders one content block per pane layer; any of them holding the reply counts.
			await expect(page.locator(".omp-transcript-content", { hasText: word }).first()).toBeVisible({
				timeout: 180_000,
			});
		}
		const { sessionFile } = await command<{ sessionFile?: string }>(page, tabId, { type: "get_state" });
		if (!sessionFile) throw new Error("No session file");
		const idleFrom = Date.now();
		await expect
			.poll(async () => (await entries(sessionFile)).some(entry => entry.type === "compaction"), {
				timeout: 240_000,
				intervals: [5_000],
			})
			.toBe(true);
		// Not before stock's 60 s minimum.
		expect(Date.now() - idleFrom).toBeGreaterThan(55_000);
		await page.screenshot({ path: test.info().outputPath("idle-compacted.png"), animations: "disabled" });
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("real omp: a goal whose time limit runs out is paused like stock's own pause", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(600_000);
	const { app, page, tabId, profile } = await launchReal();
	try {
		await setSetting(page, "goal.enabled", true);
		const toolNames = async () =>
			(await command<{ tools: Array<{ name: string }> }>(page, tabId, { type: "get_active_tools" })).tools.map(
				tool => tool.name,
			);
		const before = await toolNames();
		expect(before).not.toContain("goal");
		await command(page, tabId, {
			type: "set_goal",
			objective:
				"Run the bash command `sleep 20` six times, strictly one call after another, and only then mark the goal complete.",
			timeLimitMinutes: 1,
		});
		await expect.poll(toolNames, { timeout: 60_000 }).toContain("goal");
		const { sessionFile } = await command<{ sessionFile?: string }>(page, tabId, { type: "get_state" });
		if (!sessionFile) throw new Error("No session file");
		// Stock writes the session file once the first assistant reply lands; the entry follows then.
		await expect
			.poll(async () => (await entries(sessionFile)).some(entry => entry.customType === "ompdesk.goal-time-limit"), {
				timeout: 120_000,
			})
			.toBe(true);

		await expect(page.getByText("Goal paused: its 1 min time limit ran out.", { exact: false })).toBeVisible({
			timeout: 240_000,
		});
		await expect
			.poll(async () => (await command<{ status?: string }>(page, tabId, { type: "get_goal" })).status, {
				timeout: 30_000,
			})
			.toBe("paused");
		await page.screenshot({ path: test.info().outputPath("goal-paused.png"), animations: "disabled" });
		// Stock's pause also takes the goal tool back out and stops the continuation.
		await expect
			.configure({ soft: true })
			.poll(toolNames, { message: "the goal tool after the limit pause", timeout: 30_000 })
			.not.toContain("goal");
		await expect
			.poll(async () => (await command<{ isStreaming?: boolean }>(page, tabId, { type: "get_state" })).isStreaming, {
				timeout: 240_000,
			})
			.toBe(false);
		const turnsAtRest = (await entries(sessionFile)).filter(entry => entry.message?.role === "assistant").length;
		// Resume continues the goal through stock past the limit it already used: the limit grows by its
		// span instead of pausing the goal again at once.
		const resumedAt = await command<{ status?: string; timeUsedSeconds?: number; timeLimitSeconds?: number | null }>(
			page,
			tabId,
			{ type: "set_goal", action: "resume" },
		);
		expect.soft(resumedAt.status, JSON.stringify(resumedAt)).toBe("active");
		expect
			.soft(resumedAt.timeLimitSeconds ?? 0, JSON.stringify(resumedAt))
			.toBeGreaterThan(resumedAt.timeUsedSeconds ?? 0);
		await expect.poll(toolNames, { timeout: 60_000 }).toContain("goal");
		await expect
			.poll(async () => (await entries(sessionFile)).filter(entry => entry.message?.role === "assistant").length, {
				timeout: 240_000,
			})
			.toBeGreaterThan(turnsAtRest);
		await page.screenshot({ path: test.info().outputPath("goal-resumed.png"), animations: "disabled" });
		await command(page, tabId, { type: "set_goal", action: "drop" });
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
