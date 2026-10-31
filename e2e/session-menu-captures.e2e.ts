/**
 * The session row menu on this computer's rows and a paired host's, on two instances with the fake omp
 * (remote-harness.ts): one builder lists both (layout/sidebar/session-menu.ts), so a host's stored session has the
 * edits this computer's has and neither has Open, Open in new tab or Copy file path. Checked on the real surface: the
 * labels of a session a tab holds and of a stored one, on each device. Opt-in: `OMP_GUI_SESSION_MENU_SHOTS=<dir>`
 * writes `<device>-<state>-<lang>.png` of the open menu beside its row. The rules themselves are pinned by
 * `session-menu.test.ts` and `Sidebar.test.tsx`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { exitApp } from "./harness";
import {
	connectHost,
	freePort,
	type Language,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
} from "./remote-harness";

const CAPTURES = process.env.OMP_GUI_SESSION_MENU_SHOTS;

async function send(page: Page, text: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(text);
	await input.press("Enter");
}

async function menuLabels(page: Page): Promise<string[]> {
	return (await page.getByRole("menu").getByRole("menuitem").allTextContents()).map(label => label.trim());
}

/** The open menu with the row it belongs to, once its fade-in ended. */
async function captureMenu(page: Page, name: string): Promise<void> {
	if (!CAPTURES) return;
	const menu = page.getByRole("menu");
	await menu.evaluate(element =>
		Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)),
	);
	const box = await menu.boundingBox();
	if (!box) throw new Error("no menu to capture");
	await fs.mkdir(CAPTURES, { recursive: true });
	const top = Math.max(0, box.y - 56);
	await page.screenshot({
		path: path.join(CAPTURES, `${name}.png`),
		scale: "css",
		animations: "disabled",
		clip: {
			x: 0,
			y: top,
			width: Math.min(1280, box.x + box.width + 16),
			height: Math.min(860 - top, box.height + 72),
		},
	});
}

for (const language of ["en", "ko"] as const)
	test(`this computer's rows and a paired host's list one session menu (${language})`, async () => {
		test.setTimeout(300_000);
		const strings: Record<string, string> = language === "ko" ? ko : en;
		const text = (key: string): string => {
			const value = strings[key];
			if (value === undefined) throw new Error(`no ${language} string ${key}`);
			return value;
		};
		const edits = [
			text("sidebar.rename"),
			text("sidebar.menu.pin"),
			text("sidebar.menu.moveUp"),
			text("sidebar.menu.moveDown"),
			text("sidebar.menu.moveToProject"),
			text("sidebar.menu.archive"),
		];
		const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-session-menu-")));
		let host: RemoteInstance | null = null;
		let client: RemoteInstance | null = null;
		try {
			const hostProfile = await makeRemoteProfile(parent, "b", {
				language: language as Language,
				theme: "light",
				port: await freePort(),
			});
			const clientProfile = await makeRemoteProfile(parent, "a", {
				language: language as Language,
				theme: "light",
				port: hostProfile.port,
			});
			host = await launchRemote(hostProfile);
			client = await launchRemote(clientProfile);
			const deviceId = await connectHost(host.page, client.page, "Host B");
			const a = client.page;

			// A session on each computer: this one's in the first tab, the host's in a tab opened on it.
			await send(a, "local hello");
			await expect(a.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(1);
			const localRow = a
				.locator(
					".omp-sidebar-session-row[data-session-path$='.jsonl']:not([data-live]):not([data-sidebar-bot-row])",
				)
				.first();
			await expect(localRow).toBeVisible({ timeout: 30_000 });
			await openHostFolder(a, deviceId, hostProfile.project);
			await send(a, "remote hello");
			await expect(a.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(1);
			// Once the host's index lists the file, the row is a stored session (`data-live` goes). The host's own bot
			// session is listed there too (a plain row in its section): not the one to open.
			const hostRow = a
				.locator(`[data-sidebar-device="${deviceId}"] [data-device-session$='.jsonl']:not([data-live])`)
				.filter({ hasNotText: text("sidebar.botBadge") })
				.first();
			await expect(hostRow).toBeVisible({ timeout: 30_000 });

			const openMenu = async (row: Locator) => {
				await row.click({ button: "right" });
				await expect(a.getByRole("menu")).toBeVisible();
			};
			const closeFromMenu = async (row: Locator) => {
				await openMenu(row);
				await a.getByRole("menuitem", { name: text("sidebar.menu.closeSession"), exact: true }).click();
				await expect(a.getByRole("menu")).toHaveCount(0);
			};

			// A session a tab holds: its tab's items, one diagnostics item naming Alt, no Open.
			await openMenu(hostRow);
			const heldHost = await menuLabels(a);
			expect(heldHost.slice(0, 2)).toEqual([text("sidebar.openInNewWindow"), text("sidebar.menu.closeSession")]);
			expect(heldHost.at(-2)).toContain(text("diagnosticBundle.save"));
			expect(heldHost.at(-2)).toMatch(language === "ko" ? /(⌥|Alt) 익명화/ : /(⌥|Alt) anonymized/);
			expect(heldHost.filter(label => label.includes(text("diagnosticBundle.save")))).toHaveLength(1);
			expect(heldHost.at(-1)).toBe(text("common.delete"));
			await captureMenu(a, `host-open-${language}`);
			await a.keyboard.press("Escape");

			await openMenu(localRow);
			const heldLocal = await menuLabels(a);
			expect(heldLocal).toContain(text("sidebar.menu.closeSession"));
			expect(heldLocal.some(label => label.includes(text("diagnosticBundle.saveAnonymized")))).toBe(false);
			await captureMenu(a, `local-open-${language}`);
			await a.keyboard.press("Escape");

			// Stored sessions no tab holds: the edits, on both.
			await closeFromMenu(localRow);
			// A project no tab shows folds by default: open the one the closed tab left.
			const folded = a.locator('[data-workspace-group] button[aria-expanded="false"]');
			while ((await folded.count()) > 0) await folded.first().click();
			await openMenu(localRow);
			expect(await menuLabels(a)).toEqual([
				text("sidebar.menu.openSplit"),
				text("sidebar.openInNewWindow"),
				...edits,
				text("sidebar.menu.hideFromAgents"),
				text("sidebar.menu.reveal"),
				text("common.delete"),
			]);
			await captureMenu(a, `local-stored-${language}`);
			await a.keyboard.press("Escape");

			// The window's last tab cannot be closed from a menu: a new session beside the host's first.
			await a.locator("[data-sidebar-group-new]").first().click();
			await closeFromMenu(hostRow);
			await openMenu(hostRow);
			expect(await menuLabels(a)).toEqual([
				text("sidebar.menu.openSplit"),
				text("sidebar.openInNewWindow"),
				...edits,
				text("common.delete"),
			]);
			await captureMenu(a, `host-stored-${language}`);
			await a.keyboard.press("Escape");

			expect(client.errors).toEqual([]);
		} finally {
			if (client) await exitApp(client.app);
			if (host) await exitApp(host.app);
			await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});
