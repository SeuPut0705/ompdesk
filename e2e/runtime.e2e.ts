import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

/** The first transcript row below the viewport top, and its distance from it. */
interface ReadingAnchor {
	index: string | null;
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
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_HISTORY: "50000",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
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
		await page.mouse.wheel(0, -1500);
		await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
		const readAnchor = (): Promise<ReadingAnchor | null> =>
			scroll.evaluate(node => {
				if (node.scrollHeight - node.scrollTop - node.clientHeight < 100) return null;
				const top = node.getBoundingClientRect().top;
				const row = Array.from(node.querySelectorAll("[data-transcript-kind]")).find(
					item => item.getBoundingClientRect().bottom > top + 4,
				);
				return row
					? { index: row.getAttribute("data-index"), offset: row.getBoundingClientRect().top - top }
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
					previous.index === current.index &&
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
		const after = await scroll.evaluate((node, index) => {
			const row = node.querySelector(`[data-index="${index}"]`);
			if (!row) throw new Error("Reading anchor left the viewport during streaming");
			return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
		}, anchor.index);
		expect(Math.abs(after - anchor.offset)).toBeLessThan(4);
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
			await fs.writeFile("test-results/switch.cpuprofile", JSON.stringify(captured.profile));
			await profiler.detach();
		}
		// ⇧⌘] steps the strip order (⌃⇥ is the most-recent-first switcher, which only
		// flips between the last two tabs): 20 cycles over 5 tabs land back on the last
		// one; one more reaches the first.
		await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
		await expect(input).toHaveValue("retained stream draft");
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
		await page.evaluate(() => window.omp.sidecar.restart());
		await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
		await expect(input).toHaveValue("retained stream draft");
		await expect(input).toBeEditable();
		await fs.writeFile(
			"test-results/runtime.json",
			JSON.stringify({ history: 50000, inputMs, switchMs, anchor, after, errors }, null, 2),
		);
		await page.screenshot({ path: "test-results/runtime-recovered.png", scale: "css", animations: "disabled" });
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
