/**
 * A work card is red only when the work ended in an error (the owner's rule, 6 Nov 2026, after "왜 오류를 끝난 것처럼
 * 보이게 만드냐": a test that failed on one card and passed on the next, after the agent wrote a sentence between them,
 * left the first card a ✕ and a red box). The fake omp's `fixture turn …` prompts run one turn split into cards by a
 * reply's narration: `unfixed` (card A's test fails and is the turn's last test run; card B's git pathspec error is
 * one the agent went past), `recovered` (card B's rerun passes) and `recovered live` (card B's rerun still runs).
 * `OMP_GUI_WORK_TURN_SHOTS=<dir>` saves each turn's cards, named `<OMP_GUI_WORK_TURN_LABEL or after>-<case>.png`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

const shots = process.env.OMP_GUI_WORK_TURN_SHOTS;
const label = process.env.OMP_GUI_WORK_TURN_LABEL ?? "after";

/** The turn's cards and the narration between them, from its prompt down. */
async function capture(page: Page, prompt: Locator, name: string) {
	if (!shots) return;
	await fs.mkdir(shots, { recursive: true });
	await prompt.evaluate(element => element.scrollIntoView({ block: "start" }));
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(shots, `${label}-${name}.png`) });
}

test("a card is red only for the failure the turn ended on, never for one the agent went on past", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-work-turn-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "ko", firstRunComplete: true }));
	const app = await launchApp({ project, desktop, agent, profile });
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator("textarea").first();
		const cards = page.locator(".omp-execution-group");
		const bubble = (text: string) => page.locator(".omp-user-bubble").getByText(text, { exact: true }).last();
		const red = (card: Locator) => card.locator('[data-work-finding="error"]');
		const note = (card: Locator) => card.locator('[data-work-finding="intermediate"]');
		// The head's mark: ✕ is `failed`, whether the card's state or its verdict says it.
		const mark = (card: Locator) => card.locator(".omp-work-head > .omp-work-status").first();

		// Ended on a failed test run nothing reran: card A stays red; card B's pathspec error is a note.
		await input.fill("fixture turn unfixed");
		await input.press("Enter");
		await expect(page.getByText("One test still fails.", { exact: true })).toBeVisible({ timeout: 30_000 });
		await expect(cards).toHaveCount(2);
		await capture(page, bubble("fixture turn unfixed"), "unfixed");
		await expect.soft(mark(cards.nth(0))).toHaveAttribute("data-state", "failed");
		await expect.soft(red(cards.nth(0))).toContainText("테스트 1개 실패");
		await expect.soft(mark(cards.nth(1))).not.toHaveAttribute("data-state", "failed");
		await expect.soft(red(cards.nth(1))).toHaveCount(0);
		await expect.soft(note(cards.nth(1))).toBeVisible();

		// The rerun on card B passes: card A is no error, only a note.
		await input.fill("fixture turn recovered");
		await input.press("Enter");
		await expect(page.getByText("The tests pass now.", { exact: true })).toBeVisible({ timeout: 30_000 });
		await expect(cards).toHaveCount(4);
		await capture(page, bubble("fixture turn recovered"), "recovered");
		await expect.soft(mark(cards.nth(2))).toHaveAttribute("data-state", "complete");
		await expect.soft(red(cards.nth(2))).toHaveCount(0);
		await expect.soft(note(cards.nth(2))).toBeVisible();
		await expect.soft(cards.nth(3).locator('[data-work-finding="tests"]')).toBeVisible();

		// Card B's rerun still runs: card A's failure is no verdict yet.
		await input.fill("fixture turn recovered live");
		await input.press("Enter");
		await expect(cards).toHaveCount(6, { timeout: 30_000 });
		await expect(cards.nth(5)).toHaveAttribute("data-state", "running");
		await capture(page, bubble("fixture turn recovered live"), "live");
		await expect.soft(mark(cards.nth(4))).toHaveAttribute("data-state", "complete");
		await expect.soft(red(cards.nth(4))).toHaveCount(0);
		await expect.soft(note(cards.nth(4))).toBeVisible();
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
