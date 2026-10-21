/**
 * Quit → relaunch → resume: a turn is running, the app quits (⌘Q), and the next launch continues the turn on its
 * own, its tab showing the "Continuing where it left off…" row. The fake omp's `restore_interrupted` answers it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp } from "../../../e2e/harness";
import { caption, cleanup, launch, makeProfile, Recorder, typePrompt } from "../lib";

const PROMPT = "Move the checkout page to the new payments API and update the tests.";

async function markers(desktop: string): Promise<{ reason: string }[]> {
	try {
		return JSON.parse(await fs.readFile(path.join(desktop, "interrupted-turns.json"), "utf8"));
	} catch {
		return [];
	}
}

test("quit, relaunch, resume", async () => {
	const profile = await makeProfile({ name: "resume" });
	const first = await launch(profile, 1440, 900);
	const recorder = new Recorder("resume", { width: 1440, height: 900, maxHold: 900, endHold: 3_000 });
	let current = first.app;
	try {
		await recorder.reset();
		await recorder.attach(first.page);
		await first.page.waitForTimeout(800);
		await typePrompt(first.page, PROMPT);
		await expect(first.page.getByRole("button", { name: "Stop", exact: true }).first()).toBeVisible({
			timeout: 30_000,
		});
		await expect.poll(() => markers(profile.desktop), { timeout: 30_000 }).toMatchObject([{ reason: "running" }]);
		await first.page.waitForTimeout(2_200);
		await caption(first.page, "Quit OMPdesk while the task is running  ⌘Q");
		await first.page.waitForTimeout(1_800);
		await recorder.detach();
		// A normal quit asks nothing while "continue interrupted work" is on (the default).
		await first.app.evaluate(({ app, dialog }) => {
			dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
			setImmediate(() => app.quit());
		});
		const child = first.app.process();
		await new Promise<void>(resolve => {
			if (child.exitCode !== null || child.signalCode !== null) resolve();
			else child.once("exit", () => resolve());
		});
		expect(await markers(profile.desktop)).toMatchObject([{ reason: "running" }]);

		const second = await launch(profile, 1440, 900, { restore: true, ready: false });
		current = second.app;
		await recorder.attach(second.page);
		await caption(second.page, "Open OMPdesk again");
		await expect(second.page.locator("[data-resuming]")).toHaveCount(1, { timeout: 30_000 });
		await caption(second.page, null);
		await expect(second.page.getByText("Continued after the interruption.")).toBeVisible({ timeout: 30_000 });
		await second.page.waitForTimeout(2_200);
		await recorder.finish({ width: 1600 });
	} finally {
		await recorder.detach();
		await exitApp(current);
		await cleanup(profile);
	}
});
