import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// Drag-to-split on the fake omp with a real mouse drag: dragging an open
// session's sidebar row over the workspace previews the half the new pane will
// take (and only while over the workspace), a chip with the session title
// follows the cursor, and dropping splits on that side.
test("dragging a session previews and splits on the hovered side", async () => {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-split-drop-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
		const tabs = () => page.evaluate(() => window.omp.tabs.list());
		const first = (await tabs()).find(tab => tab.active)?.tabId;
		if (!first) throw new Error("No active tab");
		await page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Refactor auth flow" }),
			first,
		);
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabs()).length).toBe(2);
		await expect.poll(async () => (await tabs()).find(tab => tab.active)?.tabId).not.toBe(first);

		const row = page.locator(`[data-session-path="tab:${first}"]`);
		await expect(row).toContainText("Refactor auth flow");
		const rowBox = await row.boundingBox();
		const box = await page.locator(".omp-split-workspace").boundingBox();
		if (!rowBox || !box) throw new Error("expected layout boxes");
		const ghost = page.locator("[data-split-ghost]");
		const chip = page.locator("[data-split-drag-chip]");
		// Playwright's intercepted drag fires dragover per move; the last nudge settles it on the target.
		const hover = async (fx: number, fy: number) => {
			await page.mouse.move(box.x + box.width * fx + 2, box.y + box.height * fy, { steps: 8 });
			await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 2 });
		};

		await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(rowBox.x + rowBox.width / 2 + 20, rowBox.y + rowBox.height / 2, { steps: 4 });
		await expect(chip).toHaveText("Refactor auth flow");
		await expect(ghost).toHaveCount(0);
		await hover(0.08, 0.5);
		await expect(ghost).toHaveAttribute("data-split-ghost", "left");
		const ghostBox = await ghost.boundingBox();
		if (!ghostBox) throw new Error("expected ghost box");
		expect(ghostBox.x + ghostBox.width).toBeLessThanOrEqual(box.x + box.width / 2);
		await hover(0.5, 0.92);
		await expect(ghost).toHaveAttribute("data-split-ghost", "bottom");
		await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2, { steps: 8 });
		await expect(ghost).toHaveCount(0);
		await hover(0.92, 0.5);
		await expect(ghost).toHaveAttribute("data-split-ghost", "right");
		await page.mouse.up();

		await expect(page.locator(".omp-session-pane")).toHaveCount(2);
		await expect(ghost).toHaveCount(0);
		await expect(chip).toHaveCount(0);
		await expect(page.locator(".omp-session-pane").nth(1)).toHaveAttribute(
			"aria-label",
			"Session: Refactor auth flow",
		);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
