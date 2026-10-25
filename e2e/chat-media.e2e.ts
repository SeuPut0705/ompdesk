/**
 * Media and documents the agent made show in the chat. The fake omp writes a
 * tiny WebM clip, an MP3, a 40 MB MP4, a PNG, an SVG, a PDF and a page into the
 * project, reads the clip and the PNG back (stock read's `details.mediaPath`),
 * speaks the MP3 with tts ("Saved … to out/tone.mp3"), and its reply names them
 * all plus a file that is gone; a finished subagent made media of its own.
 * Players stream from main's `omp-media://` (metadata loads, the 40 MB file
 * seeks, nothing autoplays), the picture a tool already showed is not drawn
 * twice, the PDF shows its first page, the page is drawn in an empty sandbox,
 * every card offers its place (Finder/Explorer here) and its menu, the missing
 * recording is a chip, and the subagent transcript sheet shows the same. Captures: light/dark × en/ko, a narrow window, a 2×2 split.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { capture, dragTabToPane, exitApp, launchApp, openDestination, variants } from "./harness";

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
	const app = await launchApp({ project, desktop, agent, profile });
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

/** Metadata loads (duration known) through main's stream, and the player sits paused at the start. */
async function expectLoadedAndIdle(player: Locator, kind: "video" | "audio"): Promise<PlayerState> {
	await expect
		.poll(async () => {
			const state = await playerState(player);
			return state.readyState >= 1 && Number.isFinite(state.duration) && state.duration > 0;
		})
		.toBe(true);
	const state = await playerState(player);
	expect(state.src).toMatch(/^omp-media:\/\/stream\//);
	expect(state).toMatchObject({ paused: true, autoplay: false, loop: false, currentTime: 0 });
	if (kind === "video") expect(state.muted).toBe(true);
	return state;
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`chat plays the media the agent made (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const { app, page, profile, project } = await launch(language, theme);
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const input = page.locator("textarea").first();
				await input.fill("fixture media");
				await input.press("Enter");

				// The reply: the linked clip, the quoted narration and the long take play; the gone draft is a chip.
				const reply = page.locator(".omp-chat-media-list").last();
				await expect(reply).toBeVisible({ timeout: 30_000 });
				const playerNamed = (name: string) => reply.locator(".omp-chat-media").filter({ hasText: name });
				const replyVideo = playerNamed("clip.webm").locator("video");
				// Players mount near the viewport, and the cards under them push the first ones up: bring each in.
				await playerNamed("clip.webm").scrollIntoViewIfNeeded();
				await expectLoadedAndIdle(replyVideo, "video");
				await playerNamed("tone.mp3").scrollIntoViewIfNeeded();
				await expectLoadedAndIdle(playerNamed("tone.mp3").locator("audio"), "audio");
				const gone = reply.locator("[data-chat-media-unavailable='video']");
				await expect(gone).toContainText("draft.mp4");
				await expect(gone.locator("video")).toHaveCount(0);
				// 40 MB: over any IPC cap, it streams with range requests and seeks.
				const long = playerNamed("long.mp4").locator("video");
				await long.scrollIntoViewIfNeeded();
				await expectLoadedAndIdle(long, "video");
				await long.evaluate(element => {
					(element as HTMLVideoElement).currentTime = 1;
				});
				await expect
					.poll(() =>
						long.evaluate(element => {
							const video = element as HTMLVideoElement;
							return !video.seeking && video.currentTime >= 0.9 && video.paused;
						}),
					)
					.toBe(true);
				expect((await fs.stat(path.join(project, "out", "long.mp4"))).size).toBeGreaterThan(40 * 1024 * 1024);

				// Pictures: the chart draws; the frame the read already showed is not drawn again.
				const chart = reply.locator("[data-file-card='image']");
				await expect(chart).toHaveCount(1);
				await expect(chart).toContainText("chart.svg");
				await expect
					.poll(() => chart.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth))
					.toBeGreaterThan(0);
				// The PDF's first page.
				const pdf = reply.locator("[data-file-card='pdf']");
				await pdf.scrollIntoViewIfNeeded();
				await expect(pdf).toHaveAttribute("data-state", "ready");
				await expect.poll(() => pdf.locator("canvas:not([hidden])").count()).toBe(1);
				expect(await pdf.locator("canvas").evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(
					0,
				);
				// The page is drawn in an empty sandbox whose script never runs, and takes no click of its own.
				const page_ = reply.locator("[data-file-card='html']");
				const frame = page_.locator("iframe");
				await expect(frame).toHaveAttribute("sandbox", "");
				await expect(page_.frameLocator("iframe").locator("h1")).toHaveText("Fixture page");
				await expect(page_.frameLocator("iframe").locator("body")).not.toHaveAttribute("data-ran", "yes");
				await page_.scrollIntoViewIfNeeded();
				// Every card says where the file is and has its menu; the menu's Preview opens the Files viewer.
				await expect(page_.locator("[data-file-card-action='reveal']")).toBeVisible();
				await page_
					.getByRole("button", { name: language === "en" ? "More for page.html" : "page.html 메뉴" })
					.click();
				await expect(page.getByRole("menuitem")).toHaveText(
					language === "en"
						? ["Preview", "Open in default app", "Reveal in Finder", "Save a copy…", "Copy path"]
						: ["미리보기", "기본 앱으로 열기", "Finder에서 보기", "다른 곳에 저장…", "경로 복사"],
				);
				await page.keyboard.press("Escape");
				// An archive has nothing to draw: a row named by its extension.
				const bundle = reply.locator("[data-file-card='archive']");
				await expect(bundle).toHaveAttribute("data-shape", "row");
				await expect(bundle.locator("[data-file-card-meta]")).toHaveText("ZIP · 22 B");
				await capture(page, `${language}-${theme}-documents`);

				// A prompt's attachments: the line that only names them leaves the bubble, their cards come under it.
				await input.fill("Check these please\n@out/bundle.zip @out/report.pdf");
				await input.press("Enter");
				const attached = page.locator("[data-prompt-files]").last();
				await expect(attached.locator("[data-file-card]")).toHaveCount(2, { timeout: 15_000 });
				await expect(attached.locator("[data-file-card='pdf']")).toHaveAttribute("data-state", "ready");
				await expect(page.locator(".omp-user-text").last()).toHaveText("Check these please");
				await attached.scrollIntoViewIfNeeded();
				await capture(page, `${language}-${theme}-prompt-files`);

				// The work outcome row plays the clip and the narration beside the frame it read.
				const row = page.locator(".omp-work-images").last();
				// Players load only near the viewport; the row sits above the long reply.
				await row.scrollIntoViewIfNeeded();
				await expect(row.locator(".omp-chat-media")).toHaveCount(2);
				await expect(row.locator(".omp-work-image img")).toHaveCount(1);
				await expectLoadedAndIdle(row.locator("video"), "video");
				await expectLoadedAndIdle(row.locator("audio"), "audio");
				// Every player in the window is idle: nothing started on its own.
				const players = page.locator(".omp-chat-media video, .omp-chat-media audio");
				for (const player of await players.all()) expect((await playerState(player)).paused).toBe(true);

				await row.scrollIntoViewIfNeeded();
				await capture(page, `${language}-${theme}`);
				await reply.scrollIntoViewIfNeeded();
				await capture(page, `${language}-${theme}-reply`);

				// The player's menu previews the file: the Files viewer streams the same file.
				await playerNamed("clip.webm")
					.getByRole("button", { name: language === "en" ? "More for clip.webm" : "clip.webm 메뉴" })
					.click();
				await page.getByRole("menuitem", { name: language === "en" ? "Preview" : "미리보기" }).click();
				const viewer = page.locator("[data-viewer='video'] video");
				await expect(viewer).toBeVisible();
				await expect
					.poll(() => viewer.evaluate(element => (element as HTMLVideoElement).readyState))
					.toBeGreaterThanOrEqual(1);
				expect(await viewer.evaluate(element => (element as HTMLVideoElement).currentSrc)).toMatch(/^omp-media:/);
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
					await dragTabToPane(page, second.tabId, 0, 0.92, 0.5);
					await expect(page.locator(".omp-session-pane")).toHaveCount(2);
					for (const targetIndex of [0, 2]) {
						const tab = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
						if (!tab?.tabId) throw new Error("No spawned split tab");
						await dragTabToPane(page, tab.tabId, targetIndex, 0.5, 0.92);
					}
					await expect(page.locator(".omp-session-pane")).toHaveCount(4);
					const pane = page.locator(`[data-tab-id="${first}"]`);
					// Players load only near the viewport, and a quarter pane under the composer's suggestion chips
					// shows a few lines: bring the reply's last clip in first, then its player mounts.
					const paneMedia = pane.locator(".omp-chat-media-list [data-chat-media='video']").last();
					await paneMedia.scrollIntoViewIfNeeded();
					const paneVideo = paneMedia.locator("video");
					await expectLoadedAndIdle(paneVideo, "video");
					const paneBox = await pane.boundingBox();
					const videoBox = await paneVideo.boundingBox();
					if (!paneBox || !videoBox) throw new Error("Missing split geometry");
					expect(videoBox.x + videoBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
					await capture(page, "split-2x2-en-dark");
					// The agents hub follows the focused pane: focus the one that ran the work again.
					await pane.locator("textarea").click();
					await expect(pane).toHaveAttribute("data-active", "true");
				}
				// The subagent transcript sheet: its read's contact sheet, the clip it read, and the
				// files its reply names.
				await openDestination(page, "agents");
				await page
					.getByRole("button", { name: language === "en" ? "View messages" : "메시지 보기" })
					.first()
					.click();
				const sheet = page.locator("[data-sheet-panel][role='dialog']");
				// The read's contact sheet and the clip it read sit under the collapsed work card. Players mount only
				// near the viewport, and the sheet scrolls: bring each player's box in first.
				const toolMedia = sheet.locator(".omp-subagent-media");
				await expect(toolMedia.locator("img").first()).toBeVisible();
				const clip = toolMedia.locator("[data-chat-media='video']").first();
				await clip.scrollIntoViewIfNeeded();
				await expectLoadedAndIdle(clip.locator("video"), "video");
				// The files its reply names sit under the reply, as in the main transcript.
				const replyFiles = sheet.locator(".omp-chat-media-list").last();
				const narration = replyFiles.locator("[data-chat-media='audio']");
				await narration.scrollIntoViewIfNeeded();
				await expectLoadedAndIdle(narration.locator("audio"), "audio");
				await expect(replyFiles.locator("[data-file-card='image']")).toContainText("chart.svg");
				await capture(page, `${language}-${theme}-subagent-sheet`);

				// The project still holds what the agent wrote; the player read it, never moved it.
				await expect(fs.stat(path.join(project, "out", "clip.webm"))).resolves.toBeTruthy();
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
