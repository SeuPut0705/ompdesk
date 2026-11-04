import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { captureTo, exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

/**
 * Local inference engine detection on the real system omp, in a private copy of the user's config and credentials
 * (`e2e/real-omp.ts`); fake omp cannot show it, because the point is stock's live reload of models.yml. No model is
 * called. A stand-in engine answers `/v1/models` on a random loopback port; `OMP_GUI_TEST_LOCAL_ENGINES` names it as
 * the engine table.
 *
 * Offline → nothing listed. Online → the provider is in Settings › Models & accounts › Custom endpoints and its model
 * in the composer's model picker, with nobody adding anything. Offline again → both gone. Online again → both back.
 * A provider the person deletes in the list stays deleted while the engine keeps answering.
 *
 * - `OMP_GUI_LOCAL_ENGINES_REAL=1`: run it.
 * - `OMP_GUI_LOCAL_ENGINES_SHOTS=<dir>`: run it and capture each step of the desktop window. The phone's 390 px is the
 *   phone page, not this window (the app's window has a minimum width): `bun run parity -- settings-models`.
 */
const SHOTS = process.env.OMP_GUI_LOCAL_ENGINES_SHOTS;
const REAL = process.env.OMP_GUI_LOCAL_ENGINES_REAL === "1" || SHOTS !== undefined;
const PROVIDER = "stand-in-engine";
const MODEL = "test-model";
const PAUSE_MS = 400;

/** A `/v1/models` server that can be told to stop answering, as an engine that was quit does. */
async function standInEngine() {
	let online = false;
	const server = http.createServer((request, response) => {
		if (online && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: MODEL }] }));
		} else {
			response.writeHead(503);
			response.end();
		}
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		port,
		setOnline: (value: boolean) => {
			online = value;
		},
		close: () => server.close(),
	};
}

async function launchReal(port: number) {
	const { profile, project, desktop, env } = await realOmpProfile({ language: "en" });
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
		],
		env: {
			...env,
			OMP_GUI_TEST_LOCAL_ENGINES: JSON.stringify([
				{ id: PROVIDER, name: "Stand-in engine", baseUrl: `http://127.0.0.1:${port}/v1` },
			]),
			OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS: String(PAUSE_MS),
		},
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
		.toMatchObject({ status: "ready" });
	return { app, page, profile };
}

/** Whether the model picker, searched for the stand-in engine's model, lists it; `shot` runs while it is open. The picker is closed again. */
async function pickerLists(page: Page, shot?: () => Promise<void>): Promise<boolean> {
	await page.locator("button[data-model-chip]").first().click();
	const search = page.getByPlaceholder("Search models…");
	await search.waitFor({ state: "visible", timeout: 15_000 });
	await search.fill(MODEL);
	await page.waitForTimeout(200);
	const listed = (await page.locator("[data-model-option]", { hasText: MODEL }).count()) > 0;
	await shot?.();
	await page.keyboard.press("Escape");
	return listed;
}

test("real omp: a local engine that answers lists its models by itself, and leaves the list when it stops", async () => {
	test.skip(!REAL, "Opt-in: runs the system omp on a private copy of the user's config");
	test.setTimeout(300_000);
	const engine = await standInEngine();
	const { app, page } = await launchReal(engine.port);
	const shoot = (name: string) => captureTo(SHOTS, page, name);
	try {
		const customRow = page.locator(`#settings-models-custom [data-custom-provider="${PROVIDER}"]`);
		const openSettings = async () => {
			await page.locator('[data-destination="settings"]').first().click();
			await page.locator('[data-settings-section="models"]').click();
			await expect(page.locator("[data-local-engine-detect]")).toBeVisible();
			await page.locator("[data-local-engine-detect]").scrollIntoViewIfNeeded();
		};
		const closeSettings = async () => {
			await page.keyboard.press("Escape");
			await expect(page.locator("[data-settings-page]")).toBeHidden();
		};

		// 1. Nothing answers: nothing is listed, and the switch is on without anyone touching it.
		await openSettings();
		await expect(page.locator("[data-local-engine-detect] [role=switch]")).toBeChecked();
		await expect(customRow).toHaveCount(0);
		await shoot("1-offline-settings");

		// 2. The engine starts: the provider appears in Custom endpoints with no click, then its model in the picker.
		engine.setOnline(true);
		await expect(customRow).toBeVisible({ timeout: 30_000 });
		await expect(customRow).toContainText("127.0.0.1");
		await shoot("2-online-settings");
		await closeSettings();
		await expect.poll(() => pickerLists(page), { timeout: 30_000 }).toBe(true);
		await pickerLists(page, () => shoot("3-online-picker"));

		// 3. The engine quits: the model and the provider leave.
		engine.setOnline(false);
		await expect.poll(() => pickerLists(page), { timeout: 30_000 }).toBe(false);
		await pickerLists(page, () => shoot("4-offline-picker"));
		await openSettings();
		await expect(customRow).toHaveCount(0, { timeout: 30_000 });
		await shoot("5-offline-settings");

		// 4. It returns: both are back.
		engine.setOnline(true);
		await expect(customRow).toBeVisible({ timeout: 30_000 });
		await shoot("6-back-settings");

		// 5. The person deletes it while it answers: it stays deleted through several passes.
		await customRow.getByRole("button", { name: `Delete ${PROVIDER}` }).click();
		await page.getByRole("button", { name: "Delete", exact: true }).click();
		await expect(customRow).toHaveCount(0);
		await page.waitForTimeout(PAUSE_MS * 8);
		await expect(customRow).toHaveCount(0);
		await shoot("7-deleted-stays-deleted");

		// 6. Switch off and on again is the person's way back: the entry returns at once.
		const toggle = page.locator("[data-local-engine-detect] [role=switch]");
		await toggle.click();
		await expect(toggle).not.toBeChecked();
		await toggle.click();
		await expect(customRow).toBeVisible({ timeout: 30_000 });
		await shoot("8-switched-on-again");

		// 7. Off removes the entry the detector made.
		await toggle.click();
		await expect(customRow).toHaveCount(0, { timeout: 30_000 });
	} finally {
		engine.close();
		await exitApp(app);
	}
});
