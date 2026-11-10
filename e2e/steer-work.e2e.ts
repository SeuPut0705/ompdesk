import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { STEER_ANSWER } from "./fixture/narration";
import { exitApp, launchApp } from "./harness";

const STEER = "Also split the CI timing";

/**
 * A mid-run steer is the person's bubble in the chat between the turn's two cards, and the reply that answers it in a
 * narration thinking block shows that answer in the chat right under the steer, above the card of its own calls: live,
 * finished and after a reload. Returns the steer's transcript row (index and key), which must be the same live and
 * finished (nothing above it is regrouped when the turn ends), and the answer's offset under the steer.
 */
async function expectSteerInChat(page: Page): Promise<{ row: string; offset: number }> {
	const cards = page.locator(".omp-execution-group");
	await expect(cards).toHaveCount(2);
	await expect(cards.first().locator(".omp-work-card-button").filter({ hasText: "LaneRace" })).toHaveCount(1);
	await expect(cards.last().locator(".omp-work-card-button").filter({ hasText: "CiSpeed" })).toHaveCount(1);
	const steer = page.locator(".omp-user-bubble").filter({ hasText: STEER });
	await expect(steer).toHaveCount(1);
	const answer = page.locator(".omp-transcript-row").getByText(STEER_ANSWER, { exact: true });
	await expect(answer).toHaveCount(1);
	await expect(cards.getByText(STEER)).toHaveCount(0);
	await expect(cards.getByText(STEER_ANSWER)).toHaveCount(0);
	// Read in one frame: card, steer, answer, card, top to bottom.
	const { tops, row } = await page.evaluate(
		([steerText, answerText]) => {
			const groups = [...document.querySelectorAll(".omp-execution-group")];
			const bubble = [...document.querySelectorAll(".omp-user-bubble")].find(el =>
				el.textContent?.includes(steerText),
			);
			const said = [...document.querySelectorAll(".omp-transcript-row p")].find(el => el.textContent === answerText);
			const tops = [groups[0], bubble, said, groups[1]].map(
				element => element?.getBoundingClientRect().top ?? Number.NaN,
			);
			const wrapper = bubble?.closest<HTMLElement>("[data-index]");
			return { tops, row: `${wrapper?.dataset.index}:${wrapper?.dataset.rowKey}` };
		},
		[STEER, STEER_ANSWER] as const,
	);
	expect(tops).toEqual([...tops].sort((a, b) => a - b));
	return { row, offset: await answerOffset(page) };
}

/** How far under the steer bubble's top the answer's paragraph starts, streaming or finished. */
function answerOffset(page: Page): Promise<number> {
	return page.evaluate(
		([steerText, answerText]) => {
			const bubble = [...document.querySelectorAll(".omp-user-bubble")].find(el =>
				el.textContent?.includes(steerText),
			);
			const said = [...document.querySelectorAll(".omp-transcript-row p")].find(el => el.textContent === answerText);
			if (!bubble || !said) return Number.NaN;
			return said.getBoundingClientRect().top - bubble.getBoundingClientRect().top;
		},
		[STEER, STEER_ANSWER] as const,
	);
}

test("a steer sent mid-run is the person's message in the chat between the turn's cards, its answer right under it", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-steer-work-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator("textarea").first();
		const capture = async (state: string) => {
			const directory = process.env.OMP_GUI_WORK_SCREENSHOTS;
			if (!directory) return;
			await fs.mkdir(directory, { recursive: true });
			for (const [theme, label] of [
				["light", "OMPdesk Light"],
				["dark", "OMPdesk Dark"],
			]) {
				const draft = await input.inputValue();
				await input.fill("/theme");
				await page.getByRole("button", { name: "Send", exact: true }).click();
				const dialog = page.getByRole("dialog");
				await dialog.getByPlaceholder("Search themes…").fill(label);
				await dialog.locator("[data-theme-entry]").filter({ hasText: label }).click();
				await expect(dialog).toHaveCount(0);
				await page.getByRole("button", { name: "Close", exact: true }).evaluateAll(buttons => {
					for (const button of buttons) if (button instanceof HTMLButtonElement) button.click();
				});
				await expect(page.locator(".omp-toast-in, .omp-toast-out")).toHaveCount(0);
				await input.fill(draft);
				await page.screenshot({
					path: path.join(directory, `steer-${state}-${theme}.png`),
					animations: "disabled",
					scale: "css",
				});
			}
		};
		await input.fill("fixture steer work");
		await input.press("Enter");
		await expect(page.locator(".omp-work-card-button").filter({ hasText: "LaneRace" })).toHaveCount(1);
		const tab = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
		if (!tab) throw new Error("Missing steer tab");
		const fixture = (command: string) =>
			page.evaluate(([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }), [
				tab,
				command,
			] as const);

		// The composer steers the running turn; stock queues it until the loop takes it.
		await input.fill(STEER);
		await input.press("Enter");
		await expect(page.locator("[data-queue-pill]")).toContainText("1 queued");
		await page.locator("[data-queue-pill]").click();
		await expect(page.locator("[data-queue-popover]")).toContainText(STEER);
		await fixture("fixture:steer-next");
		await expect(page.locator("[data-queue-pill]")).toHaveCount(0);
		// The reply answering the steer is still streaming, held after stock closed its narration block: the answer
		// already reads as the reply under the steer, once, and never as thinking.
		const streamed = page.getByText(STEER_ANSWER, { exact: true });
		await expect(streamed).toHaveCount(1);
		await expect(streamed).toBeVisible();
		await expect(page.locator("[data-transcript-kind='streaming']").getByText(STEER_ANSWER)).toHaveCount(1);
		await expect(page.locator(".omp-thinking-block").getByText(STEER_ANSWER)).toHaveCount(0);
		await expect(page.locator(".omp-execution-group").getByText(STEER_ANSWER)).toHaveCount(0);
		const steerBubble = page.locator(".omp-user-bubble").filter({ hasText: STEER });
		const [steerBox, answerBox] = await Promise.all([steerBubble.boundingBox(), streamed.boundingBox()]);
		expect(steerBox && answerBox && steerBox.y < answerBox.y).toBe(true);
		await capture("streaming");
		// The answer streams where it will stay: when its message ends and its call starts the card under it, and when
		// the turn ends, it neither moves under the steer nor changes row.
		const streamedOffset = await answerOffset(page);
		await fixture("fixture:steer-answer");
		const live = await expectSteerInChat(page);
		await expect(page.locator('.omp-live-step[data-state="running"]:not([data-nested="true"])')).toHaveCount(1);
		await capture("live");

		await fixture("fixture:steer-finish");
		await expect(page.locator('.omp-live-step[data-outcome="true"]').last()).toBeVisible();
		// The steer keeps its row when the turn ends: nothing above it is regrouped.
		const finished = await expectSteerInChat(page);
		expect(finished.row).toBe(live.row);
		await expect(page.locator('.omp-live-step[data-state="running"]')).toHaveCount(0);
		// Each card's head, its time left out: the fake omp stamps the first card's calls within one millisecond, which
		// the live tool clock reads as 1ms and the transcript's stamps as nothing.
		const summaries = () =>
			page
				.locator(".omp-execution-group-header")
				.evaluateAll(heads => heads.map(head => head.getAttribute("aria-label")?.replace(/ · [\d.]+m?s$/, "")));
		const finishedSummaries = await summaries();
		// Whole lane rows: name, conclusion and duration, each from stock's transcript records.
		const lanes = page.locator(".omp-work-card-button");
		await expect(lanes.filter({ hasText: "LaneRace" })).toContainText("The lane conclusion race is fixed.");
		await expect(lanes.filter({ hasText: "LaneRace" })).toContainText("2.4s");
		const finishedLanes = await lanes.allTextContents();
		await capture("finished");

		// A reloaded window hydrates the same rows from the transcript, with the same heads.
		await page.reload();
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const reloaded = await expectSteerInChat(page);
		console.log(
			`[steer-answer offset] streaming ${streamedOffset} live ${live.offset} finished ${finished.offset} reloaded ${reloaded.offset}`,
		);
		expect([live.offset, finished.offset, reloaded.offset]).toEqual([streamedOffset, streamedOffset, streamedOffset]);
		await expect(page.locator(".omp-work-head [data-incoming] > .omp-work-narrative").last()).toHaveText(
			"Work complete",
		);
		expect(await summaries()).toEqual(finishedSummaries);
		await expect(lanes).toHaveText(finishedLanes);
		await capture("hydrated");
		const directory = process.env.OMP_GUI_WORK_SCREENSHOTS;
		if (directory) {
			await page.evaluate(() => window.omp.prefs.set("language", "ko"));
			await page.reload();
			await expectSteerInChat(page);
			await expect(page.locator(".omp-work-head [data-incoming] > .omp-work-narrative").last()).toHaveText(
				"작업을 완료했어요",
			);
			await page.screenshot({
				path: path.join(directory, "steer-hydrated-ko-dark.png"),
				animations: "disabled",
				scale: "css",
			});
		}
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
