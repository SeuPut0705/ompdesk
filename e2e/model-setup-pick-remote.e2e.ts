import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, openHostFolder, type RemoteInstance } from "./remote-harness";

/**
 * The model "Find more evidence" researches with is one value per machine: a pick made in the host's own window is
 * what a paired computer viewing the host opens on, and the paired computer's pick is what the host's window then
 * opens on (`MODEL_SETUP_PICK_GET|SET` → `host.modelSetup.pick.*`, the host's pref). Two apps on the fake omp; the
 * host lists the fixture model and Anthropic's two Claude models (`OMP_GUI_TEST_LOGIN`/`OMP_GUI_TEST_MODELS`).
 */

const TRIGGER = "[role=dialog] [data-model-setup-evidence] [aria-haspopup=listbox]";

async function openWizard(page: Page): Promise<void> {
	const settings = page.locator("[data-settings-page]");
	if (!(await settings.isVisible())) await page.keyboard.press("ControlOrMeta+Comma");
	await settings.locator('[data-settings-section="models"]').click();
	await settings.locator("#settings-models-setup [data-model-setup-open]").click();
	await expect(page.locator(TRIGGER)).toBeVisible({ timeout: 30_000 });
}

async function closeWizard(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await expect(page.locator("[role=dialog] [data-model-setup-evidence]")).toHaveCount(0);
}

/** Pick `name` in the research model list and wait until the trigger shows it. */
async function pick(page: Page, name: string): Promise<void> {
	await page.locator(TRIGGER).click();
	await page.getByRole("listbox").getByRole("option", { name }).click();
	await expect(page.locator(TRIGGER)).toContainText(name);
}

test("a research model picked on the host is what a paired computer opens on, and back", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-model-setup-pick-")));
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1" },
		});
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const b = host.page;
		const a = client.page;
		const deviceId = await connectHost(b, a, "Host B");
		await openHostFolder(a, deviceId, hostProfile.project);

		// B's own window starts on its default role's model (Sonnet in the fixture), then picks Opus.
		await openWizard(b);
		await expect(b.locator(TRIGGER)).not.toContainText("Opus 4.1");
		await expect(b.locator(TRIGGER)).not.toContainText("Local fixture");
		await pick(b, "Opus 4.1");
		await closeWizard(b);

		// A, viewing B, opens on B's pick, and picks another.
		await openWizard(a);
		await expect(a.locator(`[data-settings-device-banner="${deviceId}"]`)).toBeVisible();
		await expect(a.locator(TRIGGER)).toContainText("Opus 4.1");
		await pick(a, "Local fixture");
		await closeWizard(a);

		// B's window opens on what A picked: one value on B, not one per viewer.
		await openWizard(b);
		await expect(b.locator(TRIGGER)).toContainText("Local fixture");
	} finally {
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await fs.rm(parent, { recursive: true, force: true });
	}
});
