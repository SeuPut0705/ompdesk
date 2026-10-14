/**
 * Audio and video the agent made play in the chat. The fake omp copies a tiny
 * WebM clip and an MP3 into the project, reads the clip back (stock read's
 * `details.mediaPath`), speaks the MP3 with tts ("Saved … to out/tone.mp3"),
 * and its reply links the clip, quotes the MP3 and names a file that is gone.
 * The work outcome row and the reply each show players whose metadata loads
 * through the Files viewer's read, nothing autoplays, and the missing file is
 * a chip. Captures: light/dark × en/ko, a narrow window, a 2×2 split.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string; project: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-chat-media-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
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
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, project };
}

interface PlayerState {
	readyState: number;
	duration: number;
	paused: boolean;
	muted: boolean;
	autoplay: boolean;
	loop: boolean;
	currentTime: number;
	src: string;
}

function playerState(player: Locator): Promise<PlayerState> {
	return player.evaluate(element => {
		const media = element as HTMLMediaElement;
		return {
			readyState: media.readyState,
			duration: media.duration,
			paused: media.paused,
			muted: media.muted,
			autoplay: media.autoplay,
			loop: media.loop,
			currentTime: media.currentTime,
			src: media.currentSrc,
		};
	});
}

/** Metadata loads (duration known) through a blob URL, and the player sits paused at the start. */
async function expectLoadedAndIdle(player: Locator, kind: "video" | "audio"): Promise<PlayerState> {
	await expect
		.poll(async () => {
			const state = await playerState(player);
			return state.readyState >= 1 && Number.isFinite(state.duration) && state.duration > 0;
		})
		.toBe(true);
	const state = await playerState(player);
	expect(state.src).toMatch(/^blob:/);
	expect(state).toMatchObject({ paused: true, autoplay: false, loop: false, currentTime: 0 });
	if (kind === "video") expect(state.muted).toBe(true);
	return state;
}

async function capture(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled", scale: "css" });
}

/** Drag a tab onto a pane edge, the user's split gesture (as live-work.e2e.ts does). */
async function dragToPane(page: Page, tabId: string, targetIndex: number, x: number, y: number): Promise<void> {
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status)
		.toBe("ready");
	const source = await page.locator(`[data-session-path="tab:${tabId}"]`).boundingBox();
	const target = await page.locator(".omp-session-pane").nth(targetIndex).boundingBox();
	if (!source || !target) throw new Error("Missing split drag geometry");
	await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
	await page.mouse.down();
	await page.mouse.move(source.x + source.width / 2 + 20, source.y + source.height / 2, { steps: 4 });
	await page.mouse.move(target.x + target.width * x + 2, target.y + target.height * y, { steps: 12 });
	await page.mouse.move(target.x + target.width * x, target.y + target.height * y, { steps: 2 });
	await expect(page.locator("[data-split-ghost]")).toHaveCount(1);
	await page.mouse.up();
}

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`chat plays the media the agent made (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const { app, page, profile, project } = await launch(language, theme);
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const input = page.locator("textarea").first();
				await input.fill("fixture media");
				await input.press("Enter");

				// The reply: the linked clip and the quoted narration play; the gone draft is a chip.
				const reply = page.locator(".omp-chat-media-list").last();
				await expect(reply).toBeVisible({ timeout: 30_000 });
				const replyVideo = reply.locator("[data-chat-media='video'] video");
				const replyAudio = reply.locator("[data-chat-media='audio'] audio");
				await expectLoadedAndIdle(replyVideo, "video");
				await expectLoadedAndIdle(replyAudio, "audio");
				const gone = reply.locator("[data-chat-media-unavailable='video']");
				await expect(gone).toContainText("draft.mp4");
				await expect(gone.locator("video")).toHaveCount(0);

				// The work outcome row plays the same two files beside its pictures.
				const row = page.locator(".omp-work-images").last();
				await expect(row.locator(".omp-chat-media")).toHaveCount(2);
				await expectLoadedAndIdle(row.locator("video"), "video");
				await expectLoadedAndIdle(row.locator("audio"), "audio");
				// Every player in the window is still idle: nothing started on its own.
				const players = page.locator(".omp-chat-media video, .omp-chat-media audio");
				for (const player of await players.all()) expect((await playerState(player)).paused).toBe(true);

				await capture(page, `${language}-${theme}`);

				// Open in Files: the Files viewer plays the file through its own reader.
				await reply
					.locator("[data-chat-media='video']")
					.getByRole("button", { name: language === "en" ? "Open in Files" : "파일 패널에서 열기" })
					.click();
				const viewer = page.locator("[data-viewer='video'] video");
				await expect(viewer).toBeVisible();
				await expect
					.poll(() => viewer.evaluate(element => (element as HTMLVideoElement).readyState))
					.toBeGreaterThanOrEqual(1);
				await capture(page, `${language}-${theme}-files-viewer`);

				if (language === "en" && theme === "dark") {
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
					await expect(replyVideo).toBeVisible();
					const narrow = await replyVideo.boundingBox();
					const content = await page.locator(".omp-transcript-content").last().boundingBox();
					if (!narrow || !content) throw new Error("Missing narrow geometry");
					expect(narrow.x + narrow.width).toBeLessThanOrEqual(content.x + content.width + 1);
					await capture(page, "narrow-en-dark");
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));

					const first = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
					if (!first) throw new Error("No active tab");
					const second = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
					if (!second?.tabId) throw new Error("No spawned tab");
					await dragToPane(page, second.tabId, 0, 0.92, 0.5);
					await expect(page.locator(".omp-session-pane")).toHaveCount(2);
					for (const targetIndex of [0, 2]) {
						const tab = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
						if (!tab?.tabId) throw new Error("No spawned split tab");
						await dragToPane(page, tab.tabId, targetIndex, 0.5, 0.92);
					}
					await expect(page.locator(".omp-session-pane")).toHaveCount(4);
					const pane = page.locator(`[data-tab-id="${first}"]`);
					const paneVideo = pane.locator(".omp-chat-media-list [data-chat-media='video'] video").last();
					await paneVideo.scrollIntoViewIfNeeded();
					await expectLoadedAndIdle(paneVideo, "video");
					const paneBox = await pane.boundingBox();
					const videoBox = await paneVideo.boundingBox();
					if (!paneBox || !videoBox) throw new Error("Missing split geometry");
					expect(videoBox.x + videoBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
					await capture(page, "split-2x2-en-dark");
				}
				// The project still holds what the agent wrote; the player read it, never moved it.
				await expect(fs.stat(path.join(project, "out", "clip.webm"))).resolves.toBeTruthy();
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
