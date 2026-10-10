import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { z } from "zod";
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
	const recordFile = path.join(profile, "record.jsonl");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_RECORD: recordFile,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
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
		const unfocused = (await tabs()).find(tab => tab.visible && !tab.active)?.tabId;
		if (!unfocused) throw new Error("expected an unfocused visible pane");
		const sessionOwner = async (tabId: string) => {
			const state = await page.evaluate(tabId => window.omp.rpc.commandForTab(tabId, { type: "get_state" }), tabId);
			const data = state.data;
			if (!data || typeof data !== "object" || !("sessionId" in data) || typeof data.sessionId !== "string")
				throw new Error("expected session identity");
			return data.sessionId;
		};
		const recordSchema = z
			.object({
				type: z.string(),
				id: z.string().optional(),
				recordedBy: z.string(),
				answers: z.unknown().optional(),
				confirmed: z.boolean().optional(),
			})
			.passthrough();
		const recorded = async (id: string) =>
			(await fs.readFile(recordFile, "utf8"))
				.trim()
				.split("\n")
				.map(line => recordSchema.parse(JSON.parse(line)))
				.filter(entry => entry.type === "extension_ui_response" && entry.id === id);
		const owner = await sessionOwner(unfocused);
		const unfocusedPane = page.locator(`[data-tab-id="${unfocused}"]`);
		await page.evaluate(
			tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "fixture ask" }),
			unfocused,
		);
		const ask = unfocusedPane.getByRole("region", { name: "Questions", exact: true });
		await expect(ask).toContainText("Where should this deploy?");
		await expect(unfocusedPane).toHaveAttribute("data-active", "false");
		await expect.poll(async () => (await tabs()).find(tab => tab.active)?.tabId).toBe(first);
		await ask.locator("[data-choice]").nth(1).click();
		await expect(ask).toContainText("Which checks should run first?");
		await ask.locator("[data-choice]").nth(0).click();
		await ask.locator("[data-choice]").nth(2).click();
		await ask.getByRole("button", { name: "Next", exact: true }).click();
		await ask.locator("[data-choice]").nth(0).click();
		await ask.getByRole("button", { name: "Submit", exact: true }).click();
		await expect(ask).toHaveCount(0);
		await expect
			.poll(() => recorded("fixture-ask"))
			.toEqual([
				expect.objectContaining({
					recordedBy: owner,
					answers: [
						{ id: "env", selectedOptions: ["Production"] },
						{ id: "checks", selectedOptions: ["Unit tests", "Lint"] },
						{ id: "notify", selectedOptions: ["Yes"] },
					],
				}),
			]);
		await page.locator(`[data-tab-id="${first}"] textarea`).first().click();
		await expect(unfocusedPane).toHaveAttribute("data-active", "false");
		await page.evaluate(
			tabId => window.omp.rpc.commandForTab(tabId, { type: "bash", command: "fixture:confirm" }),
			unfocused,
		);
		const confirm = unfocusedPane.getByRole("region", { name: "Deploy to staging?", exact: true });
		await expect(confirm).toContainText("The agent wants to run the staging deploy script.");
		await expect(unfocusedPane).toHaveAttribute("data-active", "false");
		await expect(page.locator(`[data-session-path="tab:${unfocused}"]`)).toContainText("Needs approval");
		await confirm.getByRole("button", { name: "Approve", exact: true }).click();
		await expect(confirm).toHaveCount(0);
		await expect
			.poll(() => recorded("fixture-confirm"))
			.toEqual([{ type: "extension_ui_response", id: "fixture-confirm", confirmed: true, recordedBy: owner }]);
		await expect(page.locator(`[data-session-path="tab:${unfocused}"]`)).not.toContainText("Needs approval");
		// Background spawns leave the visible tree intact while providing sidebar
		// rows for the third, fourth and replacement sessions.
		const addSession = async (title: string) => {
			const spawned = await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
			if (!spawned?.tabId) throw new Error("expected a background tab");
			const id = spawned.tabId;
			await expect.poll(async () => (await tabs()).find(tab => tab.tabId === id)?.status).toBe("ready");
			await page.evaluate(
				({ id, title }) => window.omp.rpc.commandForTab(id, { type: "bash", command: `fixture:title:${title}` }),
				{ id, title },
			);
			return id;
		};
		const dragToPane = async (id: string, paneIndex: number) => {
			const source = page.locator(`[data-session-path="tab:${id}"]`);
			const sourceBox = await source.boundingBox();
			const target = await page.locator("[data-split]").nth(paneIndex).boundingBox();
			if (!sourceBox || !target) throw new Error("expected pane drag boxes");
			await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
			await page.mouse.down();
			await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 20, sourceBox.y + sourceBox.height / 2, {
				steps: 4,
			});
			await page.mouse.move(target.x + target.width / 2 + 2, target.y + target.height * 0.92, { steps: 12 });
			await page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.92, { steps: 2 });
			await expect(ghost).toHaveAttribute("data-split-ghost", "bottom");
			return target;
		};
		const capture = async (layout: string) => {
			const directory = process.env.OMP_GUI_SPLIT_SCREENSHOTS;
			if (!directory) return;
			await fs.mkdir(directory, { recursive: true });
			// Select real named themes: changing only data-theme leaves the
			// theme engine's inline tokens in the previous scheme.
			for (const [theme, label] of [
				["light", "Porcelain"],
				["dark", "Graphite"],
			]) {
				const composer = page.locator('.omp-session-pane[data-active="true"] textarea').first();
				await composer.fill("/theme");
				await page
					.locator('.omp-session-pane[data-active="true"]')
					.getByRole("button", { name: "Send", exact: true })
					.click();
				const picker = page.getByRole("dialog");
				await picker.getByPlaceholder("Search themes…").fill(label);
				await picker
					.locator("button[aria-pressed]")
					.filter({ hasText: new RegExp(label, "i") })
					.click();
				await expect(picker).toHaveCount(0);
				// Let transient theme confirmations finish before reviewing the layout.
				await expect(page.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
				await page.screenshot({
					path: path.join(directory, `${layout}-${theme}.png`),
					scale: "css",
					animations: "disabled",
				});
			}
		};
		await dragToPane(await addSession("Third session"), 0);
		await page.mouse.up();
		await expect(page.locator("[data-split]")).toHaveCount(3);
		await capture("three-pane");
		await dragToPane(await addSession("Fourth session"), 2);
		await page.mouse.up();
		await expect(page.locator("[data-split]")).toHaveCount(4);
		const paneBoxes = await Promise.all(
			[0, 1, 2, 3].map(index => page.locator("[data-split]").nth(index).boundingBox()),
		);
		if (paneBoxes.some(bounds => !bounds)) throw new Error("expected four pane boxes");
		expect(paneBoxes[0]?.x).toBe(paneBoxes[1]?.x);
		expect(paneBoxes[2]?.x).toBe(paneBoxes[3]?.x);
		expect(paneBoxes[0]?.y).toBe(paneBoxes[2]?.y);
		await capture("two-by-two");
		const replaced = await dragToPane(await addSession("Replacement session"), 1);
		const replacementGhost = await ghost.boundingBox();
		if (!replacementGhost) throw new Error("expected replacement preview");
		expect(replacementGhost.width).toBeGreaterThan(replaced.width * 0.8);
		expect(replacementGhost.height).toBeGreaterThan(replaced.height * 0.8);
		await page.mouse.up();
		await expect(page.locator("[data-split]")).toHaveCount(4);
		await expect(page.locator(".omp-session-pane").nth(1)).toHaveAttribute(
			"aria-label",
			"Session: Replacement session",
		);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
