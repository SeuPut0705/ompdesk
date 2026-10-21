import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

/** The first transcript row below the viewport top (its virtual index and its key), and its distance from it. */
interface ReadingAnchor {
	index: string | null;
	key: string | null;
	offset: number;
}

test("streaming with 50k history preserves the reading anchor, supports five tasks, and recovers a draft after restart", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-"));
	const desktop = path.join(profile, "desktop"),
		agent = path.join(profile, "agent"),
		project = path.join(profile, "project");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en" }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_HISTORY: "50000",
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	try {
		await expect(page.locator("[data-transcript-kind]").first()).toBeVisible({ timeout: 60_000 });
		const input = page.locator("textarea").first();
		await input.fill("fixture stream");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
		const scroll = page.locator(".omp-transcript-scroll");
		await scroll.hover();
		// macOS animates wheel scrolls, and a loaded runner can stall that animation for longer than two reads
		// (the anchor then moved 82 px after it was taken): take it once the browser says the scroll ended.
		const ended = scroll.evaluate(node => {
			const done = Promise.withResolvers<void>();
			node.addEventListener("scrollend", () => done.resolve(), { once: true });
			setTimeout(done.resolve, 10_000);
			return done.promise;
		});
		// Every scroll from here on, for the failure message: a row the reader holds moves either with a scroll (a
		// compensation that went wrong) or without one (a row above it changed size and nothing compensated).
		await scroll.evaluate(node => {
			const log: string[] = [];
			(window as unknown as { __readingScrolls: string[] }).__readingScrolls = log;
			const started = performance.now();
			let last = node.scrollTop;
			node.addEventListener("scroll", () => {
				log.push(
					`${Math.round(performance.now() - started)}ms top=${Math.round(node.scrollTop)} Δ=${Math.round(node.scrollTop - last)} height=${node.scrollHeight}`,
				);
				last = node.scrollTop;
			});
		});
		await page.mouse.wheel(0, -1500);
		await ended;
		await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
		const readAnchor = (): Promise<ReadingAnchor | null> =>
			scroll.evaluate(node => {
				if (node.scrollHeight - node.scrollTop - node.clientHeight < 100) return null;
				const top = node.getBoundingClientRect().top;
				const row = Array.from(node.querySelectorAll("[data-transcript-kind]")).find(
					item => item.getBoundingClientRect().bottom > top + 4,
				);
				return row
					? {
							index: row.getAttribute("data-index"),
							key: row.getAttribute("data-row-key"),
							offset: row.getBoundingClientRect().top - top,
						}
					: null;
			});
		// macOS animates wheel scrolls: the view can still be moving once it leaves
		// the live edge, so take the anchor only after two reads agree.
		let settling: ReadingAnchor | null = null;
		await expect
			.poll(async () => {
				const previous = settling;
				const current = await readAnchor();
				settling = current;
				return (
					previous !== null &&
					current !== null &&
					previous.key === current.key &&
					Math.abs(previous.offset - current.offset) < 1
				);
			})
			.toBe(true);
		const anchor = await readAnchor();
		if (!anchor) throw new Error("No visible reading anchor");
		const progress = async () =>
			page.evaluate(async () => {
				const response = await window.omp.rpc.bash("fixture:progress");
				return (response.data as { chunks: number }).chunks;
			});
		const before = await progress();
		await page.evaluate(() => window.omp.rpc.bash("fixture:large-tool"));
		await expect.poll(progress).toBeGreaterThan(before + 30);
		// By the row's key: a virtual index names whichever row sits at that position, so rows inserted above the
		// reader would make it name another row.
		const after = await scroll.evaluate((node, key) => {
			const row = Array.from(node.querySelectorAll("[data-row-key]")).find(
				item => item.getAttribute("data-row-key") === key,
			);
			if (!row) throw new Error("Reading anchor left the viewport during streaming");
			return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
		}, anchor.key);
		const scrolls = await page.evaluate(() => (window as unknown as { __readingScrolls: string[] }).__readingScrolls);
		expect(
			Math.abs(after - anchor.offset),
			`row ${anchor.key} (index ${anchor.index}) moved from ${anchor.offset} to ${after}; scrolls since the wheel:\n${scrolls.slice(-40).join("\n")}`,
		).toBeLessThan(4);
		const inputMs: number[] = [];
		await input.click();
		for (const character of "retained stream draft") {
			const started = performance.now();
			await page.keyboard.type(character);
			await page.evaluate(() => {
				const { promise, resolve } = Promise.withResolvers<void>();
				requestAnimationFrame(() => resolve());
				return promise;
			});
			inputMs.push(performance.now() - started);
		}
		await expect(input).toHaveValue("retained stream draft");
		for (let index = 1; index < 5; index++) {
			await page.keyboard.press("ControlOrMeta+t");
			await expect.poll(() => page.evaluate(() => window.omp.tabs.list())).toHaveLength(index + 1);
			await expect(page.locator("[data-transcript-kind]").first()).toBeVisible();
		}
		const switchMs: number[] = [];
		const profiler = process.env.OMP_GUI_PROFILE === "1" ? await page.context().newCDPSession(page) : null;
		if (profiler) {
			await profiler.send("Profiler.enable");
			await profiler.send("Profiler.start");
		}
		for (let index = 0; index < 20; index++) {
			const started = performance.now();
			await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
			await expect(input).toBeEditable();
			switchMs.push(performance.now() - started);
		}
		if (profiler) {
			const captured = await profiler.send("Profiler.stop");
			await fs.writeFile(test.info().outputPath("switch.cpuprofile"), JSON.stringify(captured.profile));
			await profiler.detach();
		}
		// ⇧⌘] steps the strip order (⌃⇥ is the most-recent-first switcher, which only
		// flips between the last two tabs): 20 cycles over 5 tabs land back on the last
		// one; one more reaches the first.
		await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
		await expect(input).toHaveValue("retained stream draft");
		// With a draft the one action button is Send: its right click offers the Stop that keeps the draft.
		await page.locator('[data-slot="send"] button').click({ button: "right" });
		await page.locator("[data-menu-item]").filter({ hasText: "Stop" }).click();
		await expect(page.locator("[data-send-stop-hint]")).toHaveCount(0);
		await page.evaluate(() => window.omp.sidecar.restart());
		await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
		await expect(input).toHaveValue("retained stream draft");
		await expect(input).toBeEditable();
		await fs.writeFile(
			test.info().outputPath("runtime.json"),
			JSON.stringify({ history: 50000, inputMs, switchMs, anchor, after, errors }, null, 2),
		);
		await page.screenshot({
			path: test.info().outputPath("runtime-recovered.png"),
			scale: "css",
			animations: "disabled",
		});
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
