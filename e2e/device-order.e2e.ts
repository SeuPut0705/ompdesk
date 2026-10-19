/**
 * The sidebar's device sections ("This device" and each paired host) are reordered by dragging a section header and the
 * order survives a relaunch (two apps on the fake omp, remote-harness.ts). Pairs a host, drags its header above this
 * device's with real mouse moves (the drop indicator shows while dragging), relaunches the client and reads the same
 * order, then moves the host back down with Alt+ArrowDown. Rules are unit-tested next to `SidebarDeviceSections`.
 *
 * `OMP_GUI_DEVICE_ORDER=<dir>` runs the spec in ko and en, light and dark, and writes captures of the reordered sidebar
 * and one mid-drag frame (indicator + chip) at desktop width (the app) and 390 px wide (the dev harness: an Electron
 * window cannot get that narrow).
 */
import * as fs from "node:fs/promises";
import { createServer as createServer0 } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";
import { createServer } from "vite";
import { exitApp } from "./harness";
import {
	connectHost,
	type Language,
	launchRemote,
	makeRemoteProfile,
	type RemoteInstance,
	type Theme,
} from "./remote-harness";

const SHOTS = process.env.OMP_GUI_DEVICE_ORDER;
const VARIANTS: { language: Language; theme: Theme }[] = SHOTS
	? [
			{ language: "en", theme: "light" },
			{ language: "en", theme: "dark" },
			{ language: "ko", theme: "light" },
			{ language: "ko", theme: "dark" },
		]
	: [{ language: "en", theme: "light" }];

const order = (page: Page) =>
	page.locator("[data-device-slot]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-device-slot")));

async function dragTo(page: Page, from: string, to: string, release: boolean): Promise<void> {
	const source = page.locator(`[data-device-drag-handle="${from}"]`);
	const target = page.locator(`[data-device-drag-handle="${to}"]`);
	const a = await source.boundingBox();
	const b = await target.boundingBox();
	if (!a || !b) throw new Error("device headers have no box");
	const x = a.x + Math.min(a.width / 2, 60);
	await page.mouse.move(x, a.y + a.height / 2);
	await page.mouse.down();
	const toY = b.y + b.height / 2;
	const fromY = a.y + a.height / 2;
	for (let step = 1; step <= 12; step++) await page.mouse.move(x, fromY + ((toY - fromY) * step) / 12);
	if (release) await page.mouse.up();
}

for (const { language, theme } of VARIANTS) {
	test(`reorders the device sections by dragging and keeps the order (${language} ${theme})`, async () => {
		test.setTimeout(300_000);
		const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-device-order-")));
		let host: RemoteInstance | undefined;
		let client: RemoteInstance | undefined;
		const shoot = async (name: string) => {
			if (!SHOTS || !client) return;
			await fs.mkdir(SHOTS, { recursive: true });
			await client.page.screenshot({ path: path.join(SHOTS, `${name}-${language}-${theme}.png`) });
		};
		try {
			const hostProfile = await makeRemoteProfile(parent, "host", { language, theme });
			const clientProfile = await makeRemoteProfile(parent, "client", { language, theme, port: hostProfile.port });
			host = await launchRemote(hostProfile);
			client = await launchRemote(clientProfile);
			const hostId = await connectHost(host.page, client.page, "Studio B");
			const sections = () => (client as RemoteInstance).page.locator("[data-device-slot]");
			await expect(sections()).toHaveCount(2);
			await expect.poll(() => order((client as RemoteInstance).page)).toEqual(["local", hostId]);

			await test.step("dragging the host header above this device's reorders with a drop indicator", async () => {
				const page = (client as RemoteInstance).page;
				await dragTo(page, hostId, "local", false);
				await expect(page.locator("[data-device-drag-chip]")).toBeVisible();
				await expect(
					page.locator(`[data-device-slot="local"] [data-device-drop-indicator="before"]`),
				).toBeVisible();
				await expect(page.locator(`[data-device-drag-handle="${hostId}"]`)).toHaveAttribute(
					"data-dragging",
					"true",
				);
				await shoot("middrag-desktop");
				await page.mouse.up();
				await expect(page.locator("[data-device-drop-indicator]")).toHaveCount(0);
				await expect(page.locator("[data-device-drag-chip]")).toHaveCount(0);
				await expect.poll(() => order(page)).toEqual([hostId, "local"]);
			});

			await test.step("the order survives a relaunch", async () => {
				await exitApp((client as RemoteInstance).app);
				client = await launchRemote(clientProfile);
				await expect.poll(() => order((client as RemoteInstance).page)).toEqual([hostId, "local"]);
				await expect
					.poll(
						async () =>
							(await (client as RemoteInstance).page.evaluate(() => window.omp.remote.getState())).hosts[0]
								?.state,
						{ timeout: 30_000 },
					)
					.toBe("online");
				expect(await order((client as RemoteInstance).page)).toEqual([hostId, "local"]);
			});

			await test.step("captures: reordered sidebar at desktop width", async () => {
				if (!SHOTS) return;
				const instance = client as RemoteInstance;
				await instance.page.mouse.move(700, 600);
				await shoot("reordered-desktop");
			});

			await test.step("Alt+ArrowDown on the host header moves it back down", async () => {
				const page = (client as RemoteInstance).page;
				await page.locator(`[data-device-drag-handle="${hostId}"]`).focus();
				await page.keyboard.press("Alt+ArrowDown");
				await expect.poll(() => order(page)).toEqual(["local", hostId]);
				await expect(page.locator(`[data-device-drag-handle="${hostId}"]`)).toBeFocused();
			});
		} finally {
			for (const instance of [client, host]) if (instance) await exitApp(instance.app);
			for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
			await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

// Electron's window cannot go below its minimum width, so the 390 px frames come from the dev harness (phone drawer).
for (const { language, theme } of SHOTS ? VARIANTS : []) {
	test(`captures the reordered device sections at 390 px (${language} ${theme})`, async () => {
		test.setTimeout(120_000);
		const port = await freePort();
		const server = await createServer({
			configFile: path.resolve("vite.harness.config.ts"),
			server: { host: "127.0.0.1", port, strictPort: true },
			logLevel: "error",
		});
		await server.listen();
		const browser = await chromium.launch();
		try {
			const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
			const page = await context.newPage();
			await page.goto(`http://127.0.0.1:${port}/harness.html?theme=${theme}&lang=${language}`);
			await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
			await page.getByRole("button", { name: language === "ko" ? /메뉴 열기/ : /Open menu/ }).click();
			await expect(page.locator("[data-drawer] [data-device-sections]")).toBeVisible();
			await expect.poll(() => order(page)).toEqual(["local", "host-1", "host-2"]);
			const shoot = async (name: string) => {
				await fs.mkdir(SHOTS as string, { recursive: true });
				await page.screenshot({ path: path.join(SHOTS as string, `${name}-${language}-${theme}.png`) });
			};
			await dragTo(page, "host-1", "local", false);
			await expect(page.locator(`[data-device-slot="local"] [data-device-drop-indicator="before"]`)).toBeVisible();
			await expect(page.locator("[data-device-drag-chip]")).toBeVisible();
			await shoot("middrag-390");
			await page.mouse.up();
			await expect.poll(() => order(page)).toEqual(["host-1", "local", "host-2"]);
			await page.mouse.move(380, 800);
			await shoot("reordered-390");
		} finally {
			await browser.close();
			await server.close();
		}
	});
}

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createServer0();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		const port = typeof address === "object" && address ? address.port : 0;
		probe.close(() => resolve(port));
	});
	return promise;
}
