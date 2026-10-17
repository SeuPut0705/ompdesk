/**
 * Sessions on the fake omp for the scenes that need several: a titled session with a saved file, a sidebar row to
 * click, and a drag of a row onto the workspace (split view). Prompts start `fixture flow` turns here (the scene
 * profile sets OMP_GUI_README_SCENE), so a session is "finished" by its flow's `reply` op.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { fixture, flow, tabs } from "./lib";

/** The sidebar row of the session titled `title`. */
export const rowOf = (page: Page, title: string) => page.locator(".omp-sidebar-session-row", { hasText: title });

/** Click the row's main button, which opens the session. */
export const pick = (page: Page, title: string) => rowOf(page, title).locator("button[data-roving-item]").click();

/**
 * A new tab holding one finished turn, titled `title`: the prompt, one tool call and `reply`. Resolves with its
 * tab id. The tab stays the active one.
 */
export async function finishedSession(page: Page, title: string, message: string, reply: string): Promise<string> {
	const before = (await tabs(page)).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs(page)).length).toBe(before.length + 1);
	const created = (await tabs(page)).find(tab => !before.includes(tab.tabId));
	if (!created) throw new Error("No new tab");
	await expect.poll(async () => (await tabs(page)).find(tab => tab.tabId === created.tabId)?.status).toBe("ready");
	await startTurn(page, created.tabId, message);
	await fixture(page, `fixture:title:${title}`, created.tabId);
	await flow(page, { op: "reply", text: reply }, created.tabId);
	await expect
		.poll(async () => {
			const tab = (await tabs(page)).find(entry => entry.tabId === created.tabId);
			return tab?.status === "ready" ? (tab.sessionPath ?? "") : "";
		})
		.toMatch(/\.jsonl$/);
	await expect(rowOf(page, title)).toBeVisible();
	return created.tabId;
}

/** Send `message` to `tabId` and repeat its first flow op until the turn exists. */
export async function startTurn(page: Page, tabId: string, message: string): Promise<void> {
	await page.evaluate(([id, text]) => window.omp.rpc.commandForTab(id, { type: "prompt", message: text }), [
		tabId,
		message,
	] as const);
	await expect(async () =>
		flow(page, { op: "call", id: "start", name: "read", args: { path: "README.md" } }, tabId),
	).toPass({
		timeout: 15_000,
	});
	await flow(page, { op: "end", id: "start", text: "# acme-web" }, tabId);
}

/** Drag a session's sidebar row onto a spot (fx/fy within `target`'s box) of the workspace and drop it. */
export async function dragOnto(
	page: Page,
	title: string,
	target: Locator,
	fx: number,
	fy: number,
	placement: string,
): Promise<void> {
	const rowBox = await rowOf(page, title).boundingBox();
	const pane = await target.boundingBox();
	if (!rowBox || !pane) throw new Error("expected drag boxes");
	await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(rowBox.x + rowBox.width / 2 + 20, rowBox.y + rowBox.height / 2, { steps: 6 });
	await page.mouse.move(pane.x + pane.width * fx + 2, pane.y + pane.height * fy, { steps: 28 });
	await page.mouse.move(pane.x + pane.width * fx, pane.y + pane.height * fy, { steps: 4 });
	await expect(page.locator("[data-split-ghost]")).toHaveAttribute("data-split-ghost", placement);
	await page.waitForTimeout(500);
	await page.mouse.up();
}
