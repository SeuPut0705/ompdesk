/**
 * Interrupted work on a paired host's tab, on two instances with the fake omp
 * (remote-harness.ts). The host (B) owns the turns it runs for a device (A):
 * - B killed mid-turn: B's relaunch continues the turn, and A, reconnected, shows
 *   it go on; A announces nothing (it is not A's to continue);
 * - A killed mid-turn: A's relaunch skips the turn (no resuming row) and its
 *   restored tab finds the turn still running on B, in the same omp;
 * - B offline: a network failure of B's omp waits for B's connection, A shows the
 *   calm waiting row, and the wait outlives A losing B: once B is back and online,
 *   the turn goes on. Cancel on A's row calls B's wait off.
 * - A loses B while a question is open on its tab (a cut relay, both apps keep running): the
 *   question is back once the link is; and when B's omp restarted meanwhile, without it, A
 *   shows no stale card, not even after a reload.
 * - A loses B while a provider sign-in runs on its tab: B's login goes on, so the re-sent code paste
 *   is the login panel's (no chat card), which shows the sign-in again until it connects.
 * Captures in the test output directory.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { capture, exitApp, readRecords } from "./harness";
import {
	freePort,
	type Language,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	openHostFolder,
	pair,
	type RemoteInstance,
	type RemoteProfile,
} from "./remote-harness";

test.describe.configure({ mode: "parallel" });

function translate(language: Language, key: string, vars: Record<string, string | number> = {}): string {
	const template = (language === "ko" ? ko : en)[key];
	if (template === undefined) throw new Error(`no ${language} string ${key}`);
	return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** SIGKILL of the app's main process: no quit hook runs (interrupted-resume.e2e.ts). */
async function crash(app: ElectronApplication): Promise<void> {
	const pid = await app.evaluate(() => process.pid);
	process.kill(pid, "SIGKILL");
	await expect.poll(() => isRunning(pid), { timeout: 20_000, message: "the killed app must be gone" }).toBe(false);
}

/** The fake omps running in RPC mode under a profile: one per live tab of that instance. */
function ompPids(profile: RemoteProfile): number[] {
	if (process.platform === "win32") return [];
	return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
		.split("\n")
		.filter(line => line.includes(profile.root) && line.includes("rpc-ui"))
		.map(line => Number.parseInt(line, 10));
}

interface Marker {
	reason: string;
	sessionPath: string;
	device?: string;
	peer?: string;
}

async function markers(profile: RemoteProfile): Promise<Marker[]> {
	try {
		return JSON.parse(await fs.readFile(path.join(profile.desktop, "interrupted-turns.json"), "utf8")) as Marker[];
	} catch {
		return [];
	}
}

async function send(page: Page, text: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(text);
	await input.press("Enter");
}

async function remoteStatus(page: Page, deviceId: string): Promise<string | undefined> {
	return (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.device === deviceId)?.status;
}

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`the host continues a device's turn after a crash; the device skips it and finds it running (${language} ${theme})`, async () => {
			test.setTimeout(300_000);
			const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
			const hostLanguage: Language = language === "en" ? "ko" : "en";
			const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-resume-")));
			const discovery = 52_000 + Math.floor(Math.random() * 1_000) * 2;
			let host: RemoteInstance | null = null;
			let client: RemoteInstance | null = null;
			try {
				const hostProfile = await makeRemoteProfile(parent, "b", {
					language: hostLanguage,
					theme,
					discoveryPort: discovery,
					port: await freePort(),
				});
				const clientProfile = await makeRemoteProfile(parent, "a", {
					language,
					theme,
					discoveryPort: discovery + 1,
				});
				host = await launchRemote(hostProfile);
				client = await launchRemote(clientProfile);
				const deviceId = await pair(host.page, client.page, "Host B");
				await openHostFolder(client.page, deviceId, hostProfile.project);

				await test.step("B is killed mid-turn: B's relaunch continues it, A shows it go on", async () => {
					if (!client || !host) throw new Error("expected both instances");
					await send(client.page, "fixture running");
					// B keeps the marker: the turn is B's to continue.
					await expect
						.poll(() => markers(hostProfile), { timeout: 30_000 })
						.toMatchObject([{ reason: "running", peer: expect.any(String) }]);
					await crash(host.app);
					host = null;
					await expect(client.page.locator(`[data-remote-reconnecting="${deviceId}"]`)).toBeVisible();
					await capture(client.page, `${language}-${theme}-host-crashed`);
					host = await launchRemote(hostProfile, { ready: false });
					await expect(client.page.getByText("Continued after the interruption.")).toBeVisible({
						timeout: 60_000,
					});
					await expect(client.page.locator(`[data-remote-reconnecting="${deviceId}"]`)).toHaveCount(0);
					// A announces nothing: the continuation is B's.
					await expect(client.page.locator("[data-resuming]")).toHaveCount(0);
					await expect.poll(() => markers(hostProfile), { timeout: 15_000 }).toEqual([]);
					await capture(client.page, `${language}-${theme}-host-continued`);
				});

				await test.step("A is killed mid-turn: A skips it and its restored tab finds it running on B", async () => {
					if (!client || !host) throw new Error("expected both instances");
					await send(client.page, "fixture running");
					await expect
						.poll(() => markers(hostProfile), { timeout: 30_000 })
						.toMatchObject([{ reason: "running" }]);
					// The tab runs the turn on B (main's synthesized "running" status).
					await expect.poll(() => remoteStatus(client?.page as Page, deviceId)).toBe("running");
					const before = ompPids(hostProfile).length;
					await crash(client.app);
					client = await launchRemote(clientProfile, { project: false, ready: false });
					const a = client.page;
					// Re-attached mid-turn: connected ("running" once the next run event arrives).
					await expect.poll(() => remoteStatus(a, deviceId), { timeout: 60_000 }).toMatch(/^(ready|running)$/);
					await expect(a.locator("[data-resuming]")).toHaveCount(0);
					await expect.poll(() => markers(clientProfile)).toEqual([]);
					// The restored tab is the running turn's, in the omp that runs it: no second omp on its session.
					await expect(a.getByRole("button", { name: t("input.abort"), exact: true })).toBeVisible({
						timeout: 30_000,
					});
					expect(ompPids(hostProfile).length).toBe(before);
					await capture(a, `${language}-${theme}-client-relaunched`);
					await a.getByRole("button", { name: t("input.abort"), exact: true }).click();
					await expect.poll(() => markers(hostProfile), { timeout: 15_000 }).toEqual([]);
				});

				expect(client.errors).toEqual([]);
			} finally {
				if (client) await exitApp(client.app);
				if (host) await exitApp(host.app);
				await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
			}
		});

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`a network failure on the host waits for the host's connection, across a lost link (${language} ${theme})`, async () => {
			test.setTimeout(300_000);
			const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
			const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-wait-")));
			const discovery = 53_000 + Math.floor(Math.random() * 1_000) * 2;
			let host: RemoteInstance | null = null;
			let client: RemoteInstance | null = null;
			try {
				const hostProfile = await makeRemoteProfile(parent, "b", {
					language: language === "en" ? "ko" : "en",
					theme,
					discoveryPort: discovery,
					port: await freePort(),
				});
				const clientProfile = await makeRemoteProfile(parent, "a", {
					language,
					theme,
					discoveryPort: discovery + 1,
				});
				host = await launchRemote(hostProfile);
				client = await launchRemote(clientProfile);
				const a = client.page;
				const deviceId = await pair(host.page, a, "Host B");
				await openHostFolder(a, deviceId, hostProfile.project);

				// B's connection drops; A's does not: the wait is B's, and A shows it.
				await host.page.evaluate(() => window.dispatchEvent(new Event("offline")));
				await send(a, "fixture network error");
				const wait = a.locator("[data-connection-wait]");
				await expect(wait).toBeVisible({ timeout: 30_000 });
				await expect(wait).toContainText(t("chat.connectionWaitHost", { device: "Host B" }));
				await expect(a.locator(".omp-message-error")).toHaveCount(0);
				await expect.poll(() => markers(hostProfile), { timeout: 15_000 }).toMatchObject([{ reason: "network" }]);
				await capture(a, `${language}-${theme}-host-waiting`);

				// A loses B while it waits; B comes back online and the turn goes on.
				await exitApp(host.app);
				host = null;
				await expect(a.locator(`[data-remote-reconnecting="${deviceId}"]`)).toBeVisible();
				await capture(a, `${language}-${theme}-waiting-link-lost`);
				host = await launchRemote(hostProfile, { ready: false });
				await expect(a.getByText("Back online: the turn went on.")).toBeVisible({ timeout: 60_000 });
				await expect(wait).toHaveCount(0);
				await expect(a.locator(".omp-message-error")).toHaveCount(0);
				await capture(a, `${language}-${theme}-host-back-online`);

				// Cancel on A's row calls B's wait off: the failure shows, nothing retries once B is online.
				await host.page.evaluate(() => window.dispatchEvent(new Event("offline")));
				await send(a, "fixture network error");
				await expect(wait).toBeVisible({ timeout: 30_000 });
				await wait.getByRole("button", { name: t("common.cancel") }).click();
				await expect(wait).toHaveCount(0);
				await expect(a.locator(".omp-message-error")).toBeVisible();
				await expect.poll(() => markers(hostProfile), { timeout: 15_000 }).toEqual([]);
				await host.page.evaluate(() => window.dispatchEvent(new Event("online")));
				await expect(a.getByText("Back online: the turn went on.")).toHaveCount(1);
				expect(client.errors).toEqual([]);
			} finally {
				if (client) await exitApp(client.app);
				if (host) await exitApp(host.app);
				await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
			}
		});

for (const [language, theme] of [
	["en", "light"],
	["ko", "dark"],
] as const)
	test(`a question open on a host's tab comes back with the link, and goes once the host's omp restarted (${language} ${theme})`, async () => {
		test.skip(process.platform === "win32", "finds the host tab's omp with ps");
		test.setTimeout(300_000);
		const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
		const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-asks-")));
		const discovery = 54_000 + Math.floor(Math.random() * 1_000) * 2;
		const hostPort = await freePort();
		const proxy = await linkProxy(hostPort);
		let host: RemoteInstance | null = null;
		let client: RemoteInstance | null = null;
		try {
			const hostProfile = await makeRemoteProfile(parent, "b", {
				language: language === "en" ? "ko" : "en",
				theme,
				discoveryPort: discovery,
				port: hostPort,
			});
			const clientProfile = await makeRemoteProfile(parent, "a", {
				language,
				theme,
				discoveryPort: discovery + 1,
			});
			host = await launchRemote(hostProfile);
			client = await launchRemote(clientProfile);
			const a = client.page;
			const deviceId = await pair(host.page, a, "Host B", proxy.address);
			const hostOwn = ompPids(hostProfile);
			await openHostFolder(a, deviceId, hostProfile.project);
			const prompt = a.locator("[data-prompt-card]");
			const card = prompt.filter({ hasText: "Where should this deploy?" });
			const reconnecting = a.locator(`[data-remote-reconnecting="${deviceId}"]`);
			const openAsks = () =>
				a.evaluate(() => window.omp.ui.openRequests().then(open => open.map(o => o.request.id)));
			/** Cut the link, run `meanwhile` while A is away, then let A back in. */
			const away = async (name: string, meanwhile?: () => Promise<void>) => {
				await proxy.drop();
				await expect(reconnecting).toBeVisible({ timeout: 30_000 });
				await capture(a, `${language}-${theme}-${name}-link-lost`);
				await meanwhile?.();
				await proxy.restore();
				await expect(reconnecting).toHaveCount(0, { timeout: 60_000 });
				await expect.poll(() => remoteStatus(a, deviceId), { timeout: 30_000 }).toBe("ready");
			};

			await test.step("the host's omp still asks: the card is back once the link is, and its answer lands", async () => {
				await send(a, "fixture ask");
				await expect(card).toBeVisible({ timeout: 30_000 });
				await away("still-open");
				await expect(card).toBeVisible({ timeout: 30_000 });
				await expect(card).toHaveCount(1);
				expect(await openAsks()).toEqual(["fixture-ask"]);
				await capture(a, `${language}-${theme}-ask-back`);
				await prompt.locator('[data-choice="Staging"]').click();
				await prompt.locator('[data-choice="Unit tests"]').click();
				await prompt.getByRole("button", { name: t("extDialog.ask.next"), exact: true }).click();
				await prompt.locator('[data-choice="Yes"]').click();
				await prompt.getByRole("button", { name: t("extDialog.submit"), exact: true }).click();
				await expect(prompt).toHaveCount(0);
				await expect
					.poll(async () =>
						(await readRecords(hostProfile.record)).filter(
							frame => frame.type === "extension_ui_response" && frame.id === "fixture-ask",
						),
					)
					.toEqual([
						expect.objectContaining({
							answers: [
								{ id: "env", selectedOptions: ["Staging"] },
								{ id: "checks", selectedOptions: ["Unit tests"] },
								{ id: "notify", selectedOptions: ["Yes"] },
							],
						}),
					]);
			});

			await test.step("the host's omp restarts while the link is down: no stale card, even after a reload", async () => {
				await send(a, "fixture ask");
				await expect(card).toBeVisible({ timeout: 30_000 });
				const [hostedOmp, ...others] = ompPids(hostProfile).filter(pid => !hostOwn.includes(pid));
				expect(others).toEqual([]);
				if (hostedOmp === undefined) throw new Error("expected the host tab's omp");
				await away("restarted", async () => {
					process.kill(hostedOmp, "SIGKILL");
					// The host's SidecarManager starts the tab's omp again, without the question.
					await expect
						.poll(() => ompPids(hostProfile).filter(pid => !hostOwn.includes(pid) && pid !== hostedOmp), {
							timeout: 30_000,
						})
						.toHaveLength(1);
				});
				await expect.poll(openAsks).toEqual([]);
				await expect(prompt).toHaveCount(0);
				await capture(a, `${language}-${theme}-ask-gone`);
				await a.reload();
				await expect.poll(() => remoteStatus(a, deviceId), { timeout: 30_000 }).toBe("ready");
				await expect(a.locator("textarea").first()).toBeVisible();
				expect(await openAsks()).toEqual([]);
				await expect(prompt).toHaveCount(0);
			});
			expect(client.errors).toEqual([]);
		} finally {
			if (client) await exitApp(client.app);
			if (host) await exitApp(host.app);
			await proxy.close();
			await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

test("a sign-in open on a host's tab when the link drops and returns never becomes a chat card", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-login-")));
	const discovery = 54_000 + Math.floor(Math.random() * 1_000) * 2;
	const hostPort = await freePort();
	const proxy = await linkProxy(hostPort);
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		// The host's fake omp replays stock's `login` sequence (open_url, "waiting", the code paste).
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			discoveryPort: discovery,
			port: hostPort,
			env: { OMP_GUI_TEST_LOGIN: "1" },
		});
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			discoveryPort: discovery + 1,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		const deviceId = await pair(host.page, a, "Host B", proxy.address);
		await openHostFolder(a, deviceId, hostProfile.project);
		await expect.poll(() => remoteStatus(a, deviceId), { timeout: 30_000 }).toBe("ready");

		// Settings follow the focused tab: B's models. The sign-in runs on B's omp, A only shows it.
		const settings = a.locator("[data-settings-page]");
		await a.keyboard.press("ControlOrMeta+Comma");
		await settings.locator('[data-settings-section="models"]').click();
		await settings.getByRole("button", { name: "Add a provider" }).click();
		const anthropic = settings.locator("[data-login-panel]");
		await settings.getByRole("button", { name: "Connect Anthropic", exact: true }).click();
		await expect(anthropic.locator("[data-login-progress]")).toBeVisible({ timeout: 30_000 });
		await expect
			.poll(async () => (await readRecords(hostProfile.record)).some(frame => frame.type === "login"), {
				timeout: 30_000,
			})
			.toBe(true);
		const paste = a.getByLabel("Authorization code or redirect address");
		await expect(paste).toBeVisible();
		await a.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);

		// The link drops and returns: the host's omp still holds the code paste and re-sends it.
		const reconnecting = a.locator(`[data-remote-reconnecting="${deviceId}"]`);
		await proxy.drop();
		await expect(reconnecting).toBeVisible({ timeout: 30_000 });
		await proxy.restore();
		await expect(reconnecting).toHaveCount(0, { timeout: 60_000 });
		await expect.poll(() => remoteStatus(a, deviceId), { timeout: 30_000 }).toBe("ready");

		// The host's login still runs, so its re-sent code paste is the login panel's: marked, never a card.
		const prompt = a.locator("[data-prompt-card]");
		for (let tick = 0; tick < 8; tick++) {
			await expect(prompt).toHaveCount(0);
			await expect(a.getByText("Paste the authorization code")).toHaveCount(0);
			await a.waitForTimeout(250);
		}
		const open = await a.evaluate(() => window.omp.ui.openRequests());
		expect(open.map(request => request.signIn?.active)).toEqual([true]);

		// Settings open again: the panel shows the sign-in that survived the link, the paste open for B's callback.
		await a.keyboard.press("ControlOrMeta+Comma");
		await settings.locator('[data-settings-section="models"]').click();
		await settings.getByRole("button", { name: "Add a provider" }).click();
		await expect(anthropic.locator("[data-login-progress]")).toHaveText(en["providerList.login.inProgress"] ?? "", {
			timeout: 30_000,
		});
		await anthropic
			.getByLabel("Authorization code or redirect address")
			.fill("http://localhost:54545/callback?code=abc&state=xyz");
		await anthropic.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(a.getByText("Signed in to Anthropic")).toBeVisible({ timeout: 30_000 });
		await expect(anthropic.locator("[data-login-progress]")).toHaveCount(0);
		await expect(prompt).toHaveCount(0);
		expect(await a.evaluate(() => window.omp.ui.openRequests().then(list => list.map(o => o.request.id)))).toEqual(
			[],
		);
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await proxy.close();
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
