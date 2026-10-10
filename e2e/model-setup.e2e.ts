/**
 * Model setup assistant end to end on the fake omp: Settings › Models &
 * providers opens it, the default selection goes to the research job (stock
 * `--mode rpc`, `OMP_GUI_TEST_MODEL_SETUP=1`), the review drops the reply's
 * unknown role, Apply writes only the changed roles plus `advisor.enabled`,
 * the proposal comes back on reopen, and the Features advisor row opens it too.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const FIXTURE_MODEL = "fixture/local-fixture";

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
const errors: string[] = [];

interface Recorded {
	type: string;
	[key: string]: unknown;
}

async function recorded(): Promise<Recorded[]> {
	const text = await fs.readFile(record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Recorded);
}

function settingsSection(id: string): Locator {
	return page.locator(`[data-settings-section="${id}"]`);
}

async function openSettings(section: string): Promise<Locator> {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settingsSection(section).click();
	return settings;
}

test.beforeAll(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-model-setup-"));
	const project = path.join(profile, "project");
	const userData = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(userData), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(path.join(userData, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_RECORD: record,
		OMP_GUI_TEST_LOGIN: "1",
		OMP_GUI_TEST_MODELS: "1",
		OMP_GUI_TEST_MODEL_SETUP: "1",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${userData}`],
		env,
	});
	page = await app.firstWindow();
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterAll(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, "test-results/model-setup-rpc.jsonl").catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("researches the picked models, then applies only the changed roles and the advisor", async () => {
	const settings = await openSettings("models");
	await settings.locator("#settings-models-setup").getByRole("button", { name: "Set up automatically" }).click();

	const dialog = page.getByRole("dialog", { name: "Model setup assistant" });
	await expect(dialog.locator('[data-model-setup-step="pick"]')).toBeVisible();
	// The default model plus the strongest model of every other connected provider.
	await expect
		.poll(() =>
			dialog
				.locator("input[data-model-setup-model]:checked")
				.evaluateAll(inputs => inputs.map(input => input.getAttribute("data-model-setup-model")).sort()),
		)
		.toEqual([DEFAULT_MODEL, FIXTURE_MODEL]);
	await expect(dialog.getByLabel("Research model")).toHaveValue(DEFAULT_MODEL);

	const before = (await recorded()).length;
	await dialog.getByRole("button", { name: "Start research" }).click();
	await expect(dialog.locator('[data-model-setup-step="research"]')).toBeVisible();
	await expect(dialog.locator("[data-model-setup-activity]")).toContainText(/Searching the web|Reading/);

	await expect(dialog.locator('[data-model-setup-step="review"]')).toBeVisible({ timeout: 20_000 });
	// The reply's unknown "reviewer" role is dropped and reported.
	await expect(dialog.locator("tr[data-model-setup-role]")).toHaveCount(5);
	await expect(dialog.locator('tr[data-model-setup-role="reviewer"]')).toHaveCount(0);
	await expect(dialog).toContainText("Left out 1 suggestion(s)");
	await expect(dialog.locator('tr[data-model-setup-role="default"]')).toContainText("No change");
	await expect(dialog.getByRole("switch", { name: "Turn on the advisor" })).toHaveAttribute("aria-checked", "true");

	// The research job is stock `--mode rpc` limited to web search and read.
	const research = (await recorded()).slice(before).filter(entry => entry.type.startsWith("research:"));
	expect(research.map(entry => entry.type)).toEqual(["research:set_event_filter", "research:prompt"]);
	for (const entry of research) {
		expect(entry.argv).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			"--model",
			DEFAULT_MODEL,
			"--thinking",
			"auto",
			"--tools",
			"web_search,read",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-lsp",
			"--no-title",
		]);
	}

	await dialog.locator('tr[data-model-setup-role="plan"] select').selectOption(FIXTURE_MODEL);
	const beforeApply = (await recorded()).length;
	await dialog.getByRole("button", { name: "Apply", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByText("Model roles updated: 4. Advisor turned on.")).toBeVisible();

	const applied = (await recorded()).slice(beforeApply);
	expect(applied.filter(entry => entry.type === "model_role_set").map(entry => [entry.role, entry.modelId])).toEqual([
		["smol", FIXTURE_MODEL],
		["slow", DEFAULT_MODEL],
		["plan", FIXTURE_MODEL],
		["advisor", FIXTURE_MODEL],
	]);
	expect(applied.filter(entry => entry.type === "settings_set").map(entry => [entry.path, entry.value])).toEqual([
		["advisor.enabled", true],
	]);
	expect(errors).toEqual([]);
});

test("reopening shows the saved proposal, and the Features advisor row opens the assistant", async () => {
	const settings = page.locator("[data-settings-page]");
	await expect(settings).toBeVisible();
	await settingsSection("models").click();
	await expect(settings.locator("#settings-models-setup")).toContainText("Last proposal:");
	await settings.locator("#settings-models-setup").getByRole("button", { name: "Set up automatically" }).click();

	const dialog = page.getByRole("dialog", { name: "Model setup assistant" });
	await expect(dialog.locator('[data-model-setup-step="review"]')).toBeVisible();
	await expect(dialog.locator("tr[data-model-setup-role]")).toHaveCount(5);
	// The saved proposal against the roles as applied: smol and the advisor already match it.
	await expect(dialog.locator('tr[data-model-setup-role="smol"]')).toContainText("Now: Local fixture");
	await expect(dialog.locator('tr[data-model-setup-role="smol"]')).toContainText("No change");
	await expect(dialog.locator('tr[data-model-setup-role="plan"] select')).toHaveValue(DEFAULT_MODEL);

	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);

	await settingsSection("agent").click();
	const advisorRow = settings.locator('[id="setting-advisor.enabled"]');
	await expect(advisorRow.getByRole("switch")).toHaveAttribute("aria-checked", "true");
	await expect(settings.locator("#setting-advisor-model")).toBeVisible();

	await advisorRow.getByRole("button", { name: "Set up automatically" }).click();
	await expect(dialog.locator('[data-model-setup-step="review"]')).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	expect(errors).toEqual([]);
});
