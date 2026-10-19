import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp, recordsOfType } from "./harness";

// Stock's tool approval for a prompt the approval mode raised (`requestApproval` over RPC: Approve, "Approve <tool>
// for this session", Deny) reaches the app from the omp as the approval card, the title bar says the session needs
// approval, and the session option reaches the omp verbatim. The card's choices, digits and the agent/Autopilot
// answers are component- and unit-tested (ExtensionDialog.test.tsx, service.test.ts, autopilot-approver.test.ts);
// the shape itself is pinned to the installed omp by src/main/tool-approval-stock.test.ts.

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;

const composer = (): Locator => page.locator(".omp-composer-input").first();

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-approval-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_TEST_RECORD: record } });
	page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("stock's approval with the session option is the approval card and answers for the session", async () => {
	await composer().fill("fixture approval session");
	await composer().press("Enter");
	const card = page.locator(".omp-ask-dock [data-prompt-card]");
	await expect(card).toBeVisible();
	await expect(card.locator("[data-choice]")).toHaveText([/Approve$/, /Approve bash for this session/, /Deny/]);
	await expect(page.getByText("Needs approval").first()).toBeVisible();
	await card.locator('[data-choice="Approve bash for this session"]').click();
	await expect(card).toHaveCount(0);
	await expect
		.poll(async () =>
			(await recordsOfType(record, "extension_ui_response"))
				.filter(entry => entry.id === "approval-session")
				.map(entry => entry.value),
		)
		.toEqual(["Approve bash for this session"]);
});
