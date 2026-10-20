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
 * - A loses B while a reply streams on a long session and the reader has wheeled up to an older answer: the
 *   transcript and draft stay on screen through the outage, the answer the reader is on stays within 2 px of
 *   where it was in its scroller (the re-read adds a "from Host B" line to every earlier prompt, since A's prompt
 *   was the session's second device), and once the link is back the finished reply is there within about one
 *   round trip (no blank page, no reload of the whole transcript); the times go to the test's annotations.
 * Captures in the test output directory.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { capture, cssString, exitApp, readRecords, variants } from "./harness";
import {
	connectHost,
	freePort,
	type Language,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
	type RemoteProfile,
} from "./remote-harness";

test.describe.configure({ mode: "parallel" });

/** What the catch-up probe on the device's page counted (10 ms samples). */
const CatchUpProbe = z.object({
	samples: z.number(),
	blank: z.number(),
	remounted: z.number(),
	drift: z.number(),
	linkUpAt: z.number(),
	currentAt: z.number(),
	frames: z.array(z.string()),
});

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

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`the host continues a device's turn after a crash; the device skips it and finds it running (${language} ${theme})`, async () => {
			test.setTimeout(300_000);
			const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
			const hostLanguage: Language = language === "en" ? "ko" : "en";
			const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-resume-")));
			let host: RemoteInstance | null = null;
			let client: RemoteInstance | null = null;
			try {
				const hostProfile = await makeRemoteProfile(parent, "b", {
					language: hostLanguage,
					theme,
					port: await freePort(),
				});
				const clientProfile = await makeRemoteProfile(parent, "a", {
					language,
					theme,
					port: hostProfile.port,
				});
				host = await launchRemote(hostProfile);
				client = await launchRemote(clientProfile);
				const deviceId = await connectHost(host.page, client.page, "Host B");
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

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`a network failure on the host waits for the host's connection, across a lost link (${language} ${theme})`, async () => {
			test.setTimeout(300_000);
			const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
			const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-wait-")));
			let host: RemoteInstance | null = null;
			let client: RemoteInstance | null = null;
			try {
				const hostProfile = await makeRemoteProfile(parent, "b", {
					language: language === "en" ? "ko" : "en",
					theme,
					port: await freePort(),
				});
				const clientProfile = await makeRemoteProfile(parent, "a", {
					language,
					theme,
					port: hostProfile.port,
				});
				host = await launchRemote(hostProfile);
				client = await launchRemote(clientProfile);
				const a = client.page;
				const deviceId = await connectHost(host.page, a, "Host B");
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

for (const [language, theme] of variants([
	["en", "light"],
	["ko", "dark"],
] as const))
	test(`a question open on a host's tab comes back with the link, and goes once the host's omp restarted (${language} ${theme})`, async () => {
		test.skip(process.platform === "win32", "finds the host tab's omp with ps");
		test.setTimeout(300_000);
		const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
		const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-asks-")));
		const hostPort = await freePort();
		const proxy = await linkProxy(hostPort);
		let host: RemoteInstance | null = null;
		let client: RemoteInstance | null = null;
		try {
			const hostProfile = await makeRemoteProfile(parent, "b", {
				language: language === "en" ? "ko" : "en",
				theme,
				port: hostPort,
			});
			const clientProfile = await makeRemoteProfile(parent, "a", {
				language,
				theme,
				port: Number(proxy.address.split(":")[1]),
			});
			host = await launchRemote(hostProfile);
			client = await launchRemote(clientProfile);
			const a = client.page;
			const deviceId = await connectHost(host.page, a, "Host B");
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

test("a host's tab back after a lost link keeps its page and catches up in place", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-catchup-")));
	const hostPort = await freePort();
	const proxy = await linkProxy(hostPort);
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			port: hostPort,
			env: { OMP_GUI_TEST_HISTORY: "600", OMP_GUI_TEST_LATER_MS: "4000" },
		});
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: Number(proxy.address.split(":")[1]),
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		const b = host.page;
		const deviceId = await connectHost(b, a, "Host B");
		await openHostFolder(a, deviceId, hostProfile.project);
		const rows = a.locator("[data-transcript-kind]");
		await expect(rows.filter({ hasText: "History answer 599." })).toHaveCount(1, { timeout: 30_000 });
		await send(a, "fixture later");
		await expect(a.getByText("Working on it")).toBeVisible({ timeout: 30_000 });
		const draft = "a draft typed before the link went";
		await a.locator("textarea").first().fill(draft);
		// 100 ms each way from here: a page that reads the whole transcript again pays for it in round trips.
		proxy.setLatency(100);

		// The reader scrolls up with the wheel until an older answer is in view, as a person would.
		const older = rows.filter({ hasText: "History answer 591." });
		const scroller = a.locator(".omp-transcript-scroll").first();
		const box = await scroller.boundingBox();
		if (!box) throw new Error("no transcript scroller");
		await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		const inView = async () => {
			const at = await older.boundingBox().catch(() => null);
			return at !== null && at.y > box.y + 40 && at.y + at.height < box.y + box.height - 40;
		};
		for (let step = 0; step < 60 && !(await inView()); step++) {
			await a.mouse.wheel(0, -120);
			await a.waitForTimeout(50);
		}
		expect(await inView()).toBe(true);
		await a.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
		await a.waitForTimeout(500);

		// From here, every frame: is any transcript row on screen, is that answer's row still the same element, where it
		// sits inside the scroller (apart from the scroller's own place on the page, which a banner moves), and is the
		// reply there; and when the tab's status first leaves the link-down `error` (the link is back). Every frame where
		// something moved goes to `frames`. Counts ride on <html data-catch-up>.
		await a.evaluate(() => {
			const row = [...document.querySelectorAll("[data-transcript-kind]")].find(entry =>
				entry.textContent?.includes("History answer 591."),
			);
			const view = document.querySelector(".omp-transcript-scroll");
			if (!row || !view) throw new Error("History answer 591 or the scroller is not on screen");
			const inScroller = () => row.getBoundingClientRect().top - view.getBoundingClientRect().top;
			const start = inScroller();
			const probe = {
				samples: 0,
				blank: 0,
				remounted: 0,
				drift: 0,
				linkDown: false,
				linkUpAt: 0,
				currentAt: 0,
				status: "",
				frames: [] as string[],
			};
			window.omp.events.onTabSidecarStatus(payload => {
				probe.status = `${payload.status}${payload.reconnecting ? "(kept)" : ""}`;
				if (payload.status === "error") probe.linkDown = true;
				else if (probe.linkDown && !probe.linkUpAt) probe.linkUpAt = performance.now();
			});
			let last = "";
			const frame = () => {
				const shown = document.querySelectorAll("[data-transcript-kind]");
				probe.samples++;
				if (shown.length === 0) probe.blank++;
				if (!row.isConnected) probe.remounted++;
				else probe.drift = Math.max(probe.drift, Math.abs(inScroller() - start));
				const pane = view.closest(".omp-session-pane");
				const parts = [...(pane?.children ?? [])].map(child => Math.round(child.getBoundingClientRect().height));
				const line = [
					probe.status,
					`scrollTop ${Math.round(view.scrollTop)}`,
					`scrollHeight ${view.scrollHeight}`,
					`viewTop ${Math.round(view.getBoundingClientRect().top)}`,
					`viewH ${view.clientHeight}`,
					`row ${row.isConnected ? Math.round(inScroller()) : "gone"}`,
					`rows ${shown.length}`,
					`pane [${parts.join(",")}]`,
					`heights [${[...shown].map(entry => Math.round(entry.getBoundingClientRect().height)).join(",")}]`,
				].join(" · ");
				if (line !== last) probe.frames.push(`${Math.round(performance.now())} ${line}`);
				last = line;
				const tail = [...shown].slice(-4);
				if (
					!probe.currentAt &&
					probe.linkUpAt &&
					tail.some(entry => entry.textContent?.includes("Finished while you were away"))
				)
					probe.currentAt = performance.now();
				document.documentElement.dataset.catchUp = JSON.stringify(probe);
				if (!probe.currentAt || performance.now() - probe.currentAt < 1500) requestAnimationFrame(frame);
			};
			requestAnimationFrame(frame);
		});

		await proxy.drop();
		await expect(a.locator(`[data-remote-reconnecting="${deviceId}"]`)).toBeVisible({ timeout: 30_000 });
		// The host's omp finishes the reply while the device is away.
		await expect
			.poll(async () => (await b.evaluate(() => window.omp.sessions.hosted())).map(entry => entry.status), {
				timeout: 30_000,
			})
			.toEqual(["ready"]);
		const restoredAt = Date.now();
		await proxy.restore();
		await expect(rows.filter({ hasText: "Finished while you were away" })).toHaveCount(1, { timeout: 60_000 });
		const caughtUpMs = Date.now() - restoredAt;
		const readProbe = async () =>
			CatchUpProbe.parse(JSON.parse((await a.locator("html").getAttribute("data-catch-up")) ?? "null"));
		await expect.poll(async () => (await readProbe()).currentAt > 0).toBe(true);
		// The probe keeps watching 1.5 s past the reply, for a late reflow.
		await a.waitForTimeout(1600);
		const probe = await readProbe();
		const linkUpToCurrentMs = Math.round(probe.currentAt - probe.linkUpAt);
		test.info().annotations.push({
			type: "catch-up",
			description: JSON.stringify({
				caughtUpMs,
				linkUpToCurrentMs,
				blankSamples: probe.blank,
				remountedSamples: probe.remounted,
				driftPx: Math.round(probe.drift),
				samples: probe.samples,
			}),
		});
		console.log(
			`[catch-up] link restored → reply shown ${caughtUpMs} ms; link back → reply shown ${linkUpToCurrentMs} ms; blank frames ${probe.blank}, older row remounted ${probe.remounted} frames, moved ${Math.round(probe.drift)} px in its scroller (${probe.samples} frames)`,
		);
		if (probe.drift > 2) console.log(probe.frames.join("\n"));
		expect(probe.blank).toBe(0);
		expect(probe.remounted).toBe(0);
		// The reader's place: the row they scrolled to stays where it was in the scroller.
		expect(probe.drift).toBeLessThanOrEqual(2);
		await expect(rows.filter({ hasText: "History answer 599." })).toHaveCount(1);
		await expect(a.getByText("Working on it")).toHaveCount(0);
		await expect(a.locator("textarea").first()).toHaveValue(draft);
		await expect.poll(() => remoteStatus(a, deviceId), { timeout: 30_000 }).toBe("ready");
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
	const hostPort = await freePort();
	const proxy = await linkProxy(hostPort);
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		// The host's fake omp replays stock's `login` sequence (open_url, "waiting", the code paste).
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			port: hostPort,
			env: { OMP_GUI_TEST_LOGIN: "1" },
		});
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: Number(proxy.address.split(":")[1]),
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		const deviceId = await connectHost(host.page, a, "Host B");
		await openHostFolder(a, deviceId, hostProfile.project);
		await expect.poll(() => remoteStatus(a, deviceId), { timeout: 30_000 }).toBe("ready");

		// Settings follow the focused tab: B's models. The sign-in runs on B's omp, A only shows it.
		const settings = a.locator("[data-settings-page]");
		await a.keyboard.press("ControlOrMeta+Comma");
		await settings.locator('[data-settings-section="models"]').click();
		await settings.getByRole("button", { name: "Add a provider" }).click();
		const anthropic = settings.locator("[data-login-panel]");
		await settings.locator('button[data-provider-connect="anthropic"]').click();
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

test("a device deletes a host's session from its sidebar row: the host's omp lets go, the file goes, and neither relaunch brings it back", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-delete-")));
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			port: await freePort(),
		});
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const deviceId = await connectHost(host.page, client.page, "Host B");
		await openHostFolder(client.page, deviceId, hostProfile.project);
		const a = client.page;
		await send(a, "remote hello");
		await expect(a.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(1);

		const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
		const firstRow = section.locator("[data-device-session]").first();
		await expect(firstRow).toHaveAttribute("data-device-session", /\.jsonl$/, { timeout: 30_000 });
		const sessionPath = (await firstRow.getAttribute("data-device-session")) ?? "";
		const exists = () =>
			fs.stat(sessionPath).then(
				() => true,
				() => false,
			);
		expect(await exists()).toBe(true);
		const omps = ompPids(hostProfile).length;

		const row = section.locator(`[data-device-session=${cssString(sessionPath)}]`);
		await row.hover();
		await row.locator("[data-sidebar-row-menu]").click();
		await a.getByRole("menuitem", { name: "Delete session" }).click();
		const dialog = a.getByRole("dialog");
		await expect(dialog).toContainText("on Host B");
		await dialog.getByRole("button", { name: "Delete", exact: true }).click();

		await expect.poll(() => remoteStatus(a, deviceId)).toBeUndefined();
		await expect.poll(exists, { timeout: 20_000 }).toBe(false);
		await expect(row).toHaveCount(0);
		if (process.platform !== "win32") await expect.poll(() => ompPids(hostProfile).length).toBe(omps - 1);

		// Both relaunch: the session stays gone on B and in A's sidebar.
		await exitApp(client.app);
		client = null;
		await exitApp(host.app);
		host = null;
		host = await launchRemote(hostProfile, { project: false });
		client = await launchRemote(clientProfile, { project: false, ready: false });
		const after = client.page;
		await expect(after.locator(`[data-sidebar-device="${deviceId}"]`)).toHaveAttribute(
			"data-device-state",
			"online",
			{
				timeout: 60_000,
			},
		);
		await expect(after.locator(`[data-device-session=${cssString(sessionPath)}]`)).toHaveCount(0);
		expect(await exists()).toBe(false);
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

/** Quit the app the way ⌘Q does, and wait for its process to end (interrupted-resume.e2e.ts). */
async function quit(app: ElectronApplication): Promise<void> {
	await app.evaluate(({ app: electronApp, dialog }) => {
		dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
		setImmediate(() => electronApp.quit());
	});
	const child = app.process();
	const exited = Promise.withResolvers<void>();
	if (child.exitCode !== null || child.signalCode !== null) exited.resolve();
	else child.once("exit", () => exited.resolve());
	await exited.promise;
}

test("a device quitting mid-turn leaves the turn running on the host, and its relaunch adopts it", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-quit-")));
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			port: await freePort(),
		});
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const deviceId = await connectHost(host.page, client.page, "Host B");
		await openHostFolder(client.page, deviceId, hostProfile.project);
		await send(client.page, "fixture running");
		await expect.poll(() => markers(hostProfile), { timeout: 30_000 }).toMatchObject([{ reason: "running" }]);
		await expect.poll(() => remoteStatus(client?.page as Page, deviceId)).toBe("running");
		const omps = ompPids(hostProfile).length;

		// An update restart is such a quit: before, it closed every tab on the host and the turn was journaled aborted.
		await quit(client.app);
		client = null;
		// The host has seen the link end: a tab.close sent by the quit would have reached it before.
		await expect
			.poll(
				async () =>
					(await host?.page.evaluate(() => window.omp.remote.getState()))?.host.peers.some(peer => peer.online),
				{ timeout: 30_000 },
			)
			.toBe(false);
		expect(await markers(hostProfile)).toMatchObject([{ reason: "running" }]);
		if (process.platform !== "win32") expect(ompPids(hostProfile).length).toBe(omps);

		client = await launchRemote(clientProfile, { project: false, ready: false });
		const a = client.page;
		await expect.poll(() => remoteStatus(a, deviceId), { timeout: 60_000 }).toMatch(/^(ready|running)$/);
		// The relaunched tab is the running turn's, in the omp that runs it.
		await expect(a.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 30_000 });
		if (process.platform !== "win32") expect(ompPids(hostProfile).length).toBe(omps);
		await a.getByRole("button", { name: "Stop", exact: true }).click();
		await expect.poll(() => markers(hostProfile), { timeout: 15_000 }).toEqual([]);
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("the host deletes a session a device has open: the device's tab and saved layout drop it", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-host-delete-")));
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			port: await freePort(),
		});
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const deviceId = await connectHost(host.page, client.page, "Host B");
		await openHostFolder(client.page, deviceId, hostProfile.project);
		const a = client.page;
		await send(a, "remote hello");
		await expect(a.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(1);
		const firstRow = a.locator(`[data-sidebar-device="${deviceId}"] [data-device-session]`).first();
		await expect(firstRow).toHaveAttribute("data-device-session", /\.jsonl$/, { timeout: 30_000 });
		const sessionPath = (await firstRow.getAttribute("data-device-session")) ?? "";
		const exists = () =>
			fs.stat(sessionPath).then(
				() => true,
				() => false,
			);

		// The person at the host deletes it while the device's tab is idle: before, "A paired device is using this session".
		const b = host.page;
		await b.evaluate(path => window.omp.sessions.delete(path), sessionPath);
		await expect.poll(exists, { timeout: 20_000 }).toBe(false);
		await expect.poll(() => remoteStatus(a, deviceId)).toBeUndefined();
		const log = await fs.readFile(path.join(hostProfile.desktop, "logs", "gui-runtime.jsonl"), "utf8");
		expect(log).toContain('"source":"session-delete"');
		expect(log).toContain(`"session":"${path.basename(sessionPath)}"`);

		// The device's relaunch restores no tab on it.
		await exitApp(client.app);
		client = await launchRemote(clientProfile, { project: false, ready: false });
		await expect(client.page.locator(`[data-sidebar-device="${deviceId}"]`)).toHaveAttribute(
			"data-device-state",
			"online",
			{ timeout: 60_000 },
		);
		await expect(client.page.locator(`[data-device-session=${cssString(sessionPath)}]`)).toHaveCount(0);
		expect(await remoteStatus(client.page, deviceId)).toBeUndefined();
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
