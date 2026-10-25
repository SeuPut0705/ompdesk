import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { dragTabToPane, exitApp, launchApp } from "./harness";

// Opt-in audit of features meeting on one work card: a long command output, a media outcome (the
// clip a read showed and the file the reply names), a steer delivered mid-run, a connection wait
// row under the finished card, and a window reload in the middle of each. Light/dark × en/ko, a
// narrow window and a 2×2 split. OMP_GUI_WORK_INTERACTIONS=<dir> enables it and receives captures.
const OUT = process.env.OMP_GUI_WORK_INTERACTIONS ?? "";
test.skip(!OUT, "OMP_GUI_WORK_INTERACTIONS=<dir> runs the work interaction audit");
test.describe.configure({ mode: "parallel" });

interface Variant {
	name: string;
	language: "en" | "ko";
	theme: "light" | "dark";
	size: [number, number];
	split?: boolean;
}

const VARIANTS: Variant[] = [
	{ name: "en-light", language: "en", theme: "light", size: [1440, 900] },
	{ name: "ko-dark", language: "ko", theme: "dark", size: [1440, 900] },
	{ name: "ko-light-narrow", language: "ko", theme: "light", size: [720, 640] },
	{ name: "en-dark-narrow", language: "en", theme: "dark", size: [720, 640] },
	{ name: "en-light-2x2", language: "en", theme: "light", size: [1440, 900], split: true },
];

async function launch(variant: Variant) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-interactions-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(path.join(project, "out"), { recursive: true }), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.copyFile(path.resolve("e2e/media/clip.webm"), path.join(project, "out", "clip.webm"));
	await fs.copyFile(path.resolve("e2e/media/tone.mp3"), path.join(project, "out", "tone.mp3"));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: variant.language, themeName: variant.theme, firstRunComplete: true }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
	});
	const page = await app.firstWindow();
	const [width, height] = variant.size;
	await app.evaluate(
		({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size[0], size[1]),
		[width, height],
	);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, root, project };
}

/** Anything of the transcript past its column that no horizontal scroller clips, plus page overflow. */
async function spills(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const out: string[] = [];
		if (document.documentElement.scrollWidth > innerWidth + 1)
			out.push(`page ${document.documentElement.scrollWidth} > ${innerWidth}`);
		for (const scroller of document.querySelectorAll<HTMLElement>(".omp-transcript-scroll")) {
			const edge = scroller.getBoundingClientRect().right;
			if (scroller.scrollWidth > scroller.clientWidth + 1)
				out.push(`hscroll ${scroller.scrollWidth} > ${scroller.clientWidth}`);
			for (const element of scroller.querySelectorAll(".omp-transcript-content *")) {
				const box = element.getBoundingClientRect();
				if (box.width === 0 || box.right <= edge + 1) continue;
				let clipped = false;
				for (let parent = element.parentElement; parent && parent !== scroller; parent = parent.parentElement) {
					const overflow = getComputedStyle(parent).overflowX;
					if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") {
						clipped = true;
						break;
					}
				}
				if (!clipped)
					out.push(
						`${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)} right=${Math.round(box.right)} > ${Math.round(edge)}`,
					);
			}
		}
		return out;
	});
}

async function capture(page: Page, name: string): Promise<void> {
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(OUT, `${name}.png`), scale: "css", animations: "disabled" });
}

async function bash(page: Page, tab: string, command: string) {
	const response = await page.evaluate(
		([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }),
		[tab, command] as const,
	);
	if (!response.success) throw new Error(`${command}: ${response.error}`);
}

test.beforeAll(async () => {
	await fs.mkdir(OUT, { recursive: true });
});

for (const variant of VARIANTS)
	test(`media outcome, steer, wait row and reloads on one card (${variant.name})`, async () => {
		test.setTimeout(240_000);
		const { app, page, root, project } = await launch(variant);
		const errors: string[] = [];
		const found: Record<string, string[]> = {};
		page.on("pageerror", error => errors.push(error.message));
		const check = async (stage: string) => {
			found[stage] = await spills(page);
		};
		try {
			const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.active)?.tabId;
			if (!tab) throw new Error("No active tab");
			const pane = page.locator(`[data-tab-id="${tab}"]`);
			if (variant.split) {
				for (const [targetIndex, x, y] of [
					[0, 0.92, 0.5],
					[0, 0.5, 0.92],
					[2, 0.5, 0.92],
				] as const) {
					const spawned = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
					if (!spawned?.tabId) throw new Error("No spawned split tab");
					await dragTabToPane(page, spawned.tabId, targetIndex, x, y);
				}
				await expect(page.locator(".omp-session-pane")).toHaveCount(4);
			}
			const run = (spec: Record<string, unknown>) => bash(page, tab, `fixture:flow:${JSON.stringify(spec)}`);
			const cards = pane.locator(".omp-execution-group");
			const input = pane.locator("textarea").first();
			await input.click();
			await input.fill("fixture flow");
			await input.press("Enter");
			await expect(cards.first()).toBeVisible({ timeout: 15_000 });

			// A long command output: 120 lines, a few of them far wider than the pane.
			const longLine = `${"wide-column-".repeat(30)}end`;
			const lines = Array.from({ length: 120 }, (_, index) => (index % 17 === 0 ? longLine : `line ${index}`));
			await run({ op: "call", id: "b1", name: "bash", args: { command: "bun run build", intent: "Building" } });
			await run({ op: "output", id: "b1", text: lines.join("\n") });
			await check("long-output-running");
			await capture(page, `${variant.name}-1-long-output`);
			await run({ op: "end", id: "b1", text: lines.join("\n") });

			// A steer typed while the run goes, delivered after the read that shows the clip.
			await run({ op: "call", id: "r1", name: "read", args: { path: "out/clip.webm" } });
			await input.fill("Also keep the tone");
			await input.press("Enter");
			// A steer typed mid-run waits in the toolbar's queue pill, not as a bubble.
			await expect(pane.locator("[data-queue-pill]")).toBeVisible();
			await capture(page, `${variant.name}-2-steer-queued`);
			await page.reload();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect(cards.first()).toBeVisible({ timeout: 30_000 });
			await capture(page, `${variant.name}-3-reload-steer-queued`);
			await run({
				op: "end",
				id: "r1",
				text: "Video file [video/webm], 1.5s, 160x90",
				details: { mediaPath: path.join(project, "out", "clip.webm"), contentType: "video/webm" },
			});
			await run({ op: "steer" });
			await run({
				op: "reply",
				text: "Built it. The clip is [out/clip.webm](out/clip.webm) and the narration `out/tone.mp3`.",
			});
			await expect(pane.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0, { timeout: 30_000 });
			const media = pane.locator(".omp-chat-media");
			await expect(media.first()).toBeVisible({ timeout: 30_000 });
			await check("media-done");
			await capture(page, `${variant.name}-4-media-done`);

			// Reload with the media outcome on screen: the players come back, idle, once each.
			const before = await media.count();
			await page.reload();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect(media.first()).toBeVisible({ timeout: 30_000 });
			await check("media-reloaded");
			expect(await media.count(), "media players after the reload").toBe(before);
			for (const player of await pane.locator(".omp-chat-media video, .omp-chat-media audio").all())
				expect(await player.evaluate(element => (element as HTMLMediaElement).paused)).toBe(true);
			await capture(page, `${variant.name}-5-media-reloaded`);

			// The wait row under the finished card, then a reload in the middle of the wait.
			await page.evaluate(() => window.dispatchEvent(new Event("offline")));
			await input.fill("fixture network error");
			await input.press("Enter");
			const wait = pane.locator("[data-connection-wait]");
			await expect(wait).toBeVisible({ timeout: 30_000 });
			await check("wait-row");
			await capture(page, `${variant.name}-6-wait`);
			await page.reload();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await page.evaluate(() => window.dispatchEvent(new Event("offline")));
			await expect(media.first()).toBeVisible({ timeout: 30_000 });
			found.waitAfterReload = [`wait rows: ${await wait.count()}`];
			await check("wait-reloaded");
			await capture(page, `${variant.name}-7-wait-reloaded`);
			await page.evaluate(() => window.dispatchEvent(new Event("online")));
			await expect(wait).toHaveCount(0, { timeout: 30_000 });
			await capture(page, `${variant.name}-8-back-online`);

			await fs.writeFile(
				path.join(OUT, `${variant.name}-findings.json`),
				JSON.stringify({ found, errors }, null, 1),
			);
			expect(errors).toEqual([]);
			for (const [stage, list] of Object.entries(found))
				if (stage !== "waitAfterReload") expect(list, stage).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

for (const variant of VARIANTS.filter(entry => !entry.split))
	test(`stop with a queued steer after a media read, then a reload (${variant.name})`, async () => {
		test.setTimeout(180_000);
		const { app, page, root, project } = await launch(variant);
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		try {
			const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.active)?.tabId;
			if (!tab) throw new Error("No active tab");
			const run = (spec: Record<string, unknown>) => bash(page, tab, `fixture:flow:${JSON.stringify(spec)}`);
			const input = page.locator("textarea").first();
			await input.fill("fixture flow");
			await input.press("Enter");
			const cards = page.locator(".omp-execution-group");
			await expect(cards.first()).toBeVisible({ timeout: 15_000 });
			await run({ op: "call", id: "r1", name: "read", args: { path: "out/clip.webm" } });
			await run({
				op: "end",
				id: "r1",
				text: "Video file [video/webm], 1.5s, 160x90",
				details: { mediaPath: path.join(project, "out", "clip.webm"), contentType: "video/webm" },
			});
			await run({
				op: "call",
				id: "b1",
				name: "bash",
				args: { command: "sleep 30", intent: "Waiting on the server" },
			});
			await input.fill("Also keep the tone");
			await input.press("Enter");
			await expect(page.locator("[data-queue-pill]").first()).toBeVisible();
			await capture(page, `stop-${variant.name}-1-running-queued`);
			await page.getByRole("button", { name: variant.language === "en" ? "Stop" : "중단", exact: true }).click();
			await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0, { timeout: 30_000 });
			const state = async () => ({
				states: await cards.evaluateAll(groups => groups.map(group => (group as HTMLElement).dataset.state)),
				media: await page.locator(".omp-work-images .omp-chat-media").count(),
				composer: await input.inputValue(),
				overflow: await spills(page),
			});
			const stopped = await state();
			await capture(page, `stop-${variant.name}-2-stopped`);
			await page.reload();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect(cards.first()).toBeVisible({ timeout: 30_000 });
			const reloaded = await state();
			await capture(page, `stop-${variant.name}-3-reloaded`);
			await fs.writeFile(
				path.join(OUT, `stop-${variant.name}-findings.json`),
				JSON.stringify({ stopped, reloaded, errors }, null, 1),
			);
			expect(stopped.states).toEqual(["interrupted"]);
			expect(reloaded.states).toEqual(["interrupted"]);
			expect(reloaded.media, "the clip the read showed stays in the stopped card").toBe(stopped.media);
			expect(stopped.overflow).toEqual([]);
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

for (const variant of VARIANTS.filter(entry => !entry.split))
	test(`a question open beside a queued steer and a media read, then a reload (${variant.name})`, async () => {
		test.setTimeout(180_000);
		const { app, page, root, project } = await launch(variant);
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		try {
			const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.active)?.tabId;
			if (!tab) throw new Error("No active tab");
			const run = (spec: Record<string, unknown>) => bash(page, tab, `fixture:flow:${JSON.stringify(spec)}`);
			const input = page.locator("textarea").first();
			await input.fill("fixture flow");
			await input.press("Enter");
			const cards = page.locator(".omp-execution-group");
			await expect(cards.first()).toBeVisible({ timeout: 15_000 });
			await run({ op: "call", id: "r1", name: "read", args: { path: "out/clip.webm" } });
			await run({
				op: "end",
				id: "r1",
				text: "Video file [video/webm], 1.5s, 160x90",
				details: { mediaPath: path.join(project, "out", "clip.webm"), contentType: "video/webm" },
			});
			await input.fill("Also keep the tone");
			await input.press("Enter");
			await run({ op: "ask" });
			const question = page.getByRole("region", { name: variant.language === "en" ? "Question" : "질문" });
			await expect(question).toBeVisible({ timeout: 15_000 });
			const found: Record<string, unknown> = { before: await spills(page) };
			await capture(page, `ask-${variant.name}-1-open`);
			await page.reload();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect(cards.first()).toBeVisible({ timeout: 30_000 });
			await page.waitForTimeout(1500);
			found.questionAfterReload = await question.count();
			found.queuedAfterReload = await page.getByText("Also keep the tone").count();
			found.after = await spills(page);
			await capture(page, `ask-${variant.name}-2-reloaded`);
			await fs.writeFile(
				path.join(OUT, `ask-${variant.name}-findings.json`),
				JSON.stringify({ found, errors }, null, 1),
			);
			expect(found.before).toEqual([]);
			expect(found.after).toEqual([]);
			expect(found.questionAfterReload, "the open question after a reload").toBe(1);
			// The answer still reaches the omp that asked: the run goes on to its reply.
			await question.getByText("Staging").first().click();
			const submit = question.getByRole("button", {
				name: variant.language === "en" ? "Submit" : "제출",
				exact: true,
			});
			if (await submit.count()) await submit.click();
			await expect(question).toHaveCount(0);
			await run({ op: "reply", text: "Checked on staging." });
			await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0, { timeout: 30_000 });
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

for (const variant of VARIANTS.filter(entry => entry.language === "en" && !entry.split))
	test(`a plan proposal open, then a reload (${variant.name})`, async () => {
		test.setTimeout(180_000);
		const { app, page, root } = await launch(variant);
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		try {
			const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.active)?.tabId;
			if (!tab) throw new Error("No active tab");
			const run = (spec: Record<string, unknown>) => bash(page, tab, `fixture:flow:${JSON.stringify(spec)}`);
			const input = page.locator("textarea").first();
			await input.fill("fixture flow");
			await input.press("Enter");
			await expect(page.locator(".omp-execution-group").first()).toBeVisible({ timeout: 15_000 });
			await run({ op: "call", id: "w1", name: "write", args: { path: "local://PLAN.md", content: "## Steps" } });
			await run({ op: "end", id: "w1", text: "Wrote local://PLAN.md" });
			await run({ op: "propose" });
			await expect(page.getByText("Flow rollout plan").first()).toBeVisible({ timeout: 15_000 });
			await capture(page, `plan-${variant.name}-1-proposed`);
			await page.reload();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect(page.locator(".omp-execution-group").first()).toBeVisible({ timeout: 30_000 });
			await page.waitForTimeout(1500);
			const after = {
				plan: await page.getByText("Flow rollout plan").count(),
				keepContext: await page.getByText("Keep context", { exact: true }).count(),
				overflow: await spills(page),
			};
			await capture(page, `plan-${variant.name}-2-reloaded`);
			await fs.writeFile(
				path.join(OUT, `plan-${variant.name}-findings.json`),
				JSON.stringify({ after, errors }, null, 1),
			);
			expect(after.plan, "the open plan proposal after a reload").toBeGreaterThan(0);
			expect(after.overflow).toEqual([]);
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
