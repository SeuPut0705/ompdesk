/**
 * SidebarUsage's 0.128.0 regression at the owner's 227px width: three Claude accounts, one blocked in use.
 * Chromium measures the cap, wrapping and clipping that linkedom cannot. Account grouping and folds stay in
 * SidebarUsage.test.tsx. The same made-up reports feed the fake omp's blocked-account parity sheet.
 */
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { createServer } from "vite";

// One test owns its server and browser, so no fixture state crosses tests or workers.
test("the narrow sidebar keeps its accounts reachable and its blocked notice clear of Settings", async () => {
	const probe = createNetServer();
	const listening = Promise.withResolvers<void>();
	probe.once("error", listening.reject);
	probe.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = probe.address();
	if (typeof address !== "object" || !address) throw new Error("expected a listening port");
	const port = address.port;
	const closed = Promise.withResolvers<void>();
	probe.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
	const server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port, strictPort: true },
		logLevel: "error",
	});
	const browser = await chromium.launch();
	try {
		await server.listen();
		const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
		await page.addInitScript(() => localStorage.setItem("omp.sidebarWidth", "227"));
		await page.goto(`http://127.0.0.1:${port}/harness.html?theme=dark&lang=ko&usage=blocked`);
		const block = page.locator("[data-rail-pin='usage']");
		const scroller = page.locator("[data-sidebar-usage-scroll]");
		const notice = block.locator("[data-account-reason]");
		await expect(block.locator("[data-usage-account]")).toHaveCount(3);
		await expect(block.locator("[data-in-use]")).toHaveCount(1);
		await expect(notice).toContainText("다음 요청은 다른 계정을 써요.");
		for (const height of [860, 560]) {
			await page.setViewportSize({ width: 1280, height });
			const geometry = await block.evaluate(element => {
				const box = element.getBoundingClientRect();
				const sidebar = document.querySelector(".omp-session-sidebar")?.getBoundingClientRect();
				const list = document.querySelector(".omp-sidebar-list")?.getBoundingClientRect();
				const settings = document.querySelector("[data-destination='settings']")?.getBoundingClientRect();
				const note = element.querySelector("[data-account-reason]")?.getBoundingClientRect();
				return {
					height: box.height,
					width: sidebar?.width,
					listHeight: list?.height,
					settingsTop: settings?.top,
					noteTop: note?.top,
					noteBottom: note?.bottom,
				};
			});
			expect(geometry.width).toBe(227);
			expect(
				geometry.height,
				"the whole usage block, including its notice, takes at most a third",
			).toBeLessThanOrEqual(height / 3);
			expect(geometry.listHeight, "session rows retain at least a quarter of the sidebar").toBeGreaterThan(
				height / 4,
			);
			expect(geometry.noteBottom, "the complete notice stays above Settings").toBeLessThan(
				geometry.settingsTop ?? 0,
			);
			expect(geometry.noteTop).toBeGreaterThanOrEqual(0);
			// Every window's label and percentage fit inside the bar, even a missing first-column window.
			const cut = await block
				.locator(".omp-usage-gauge-text")
				.evaluateAll(
					elements =>
						elements.filter(
							element =>
								element.scrollWidth > element.clientWidth + 1 ||
								element.scrollHeight > element.clientHeight + 1,
						).length,
				);
			expect(cut, "no window label or percentage is cut").toBe(0);
			await scroller.evaluate(element => {
				element.scrollTop = element.scrollHeight;
			});
			const last = block.locator("[data-usage-account]").last();
			await expect(last).toContainText("taylor.r@example.com");
			await expect(last.locator(".omp-usage-gauge-reset")).toHaveCount(3);
			const end = await last.evaluate(element => {
				const box = element.getBoundingClientRect();
				const list = element.closest("[data-sidebar-usage-scroll]")?.getBoundingClientRect();
				return { bottom: box.bottom, cap: list?.bottom ?? 0 };
			});
			expect(end.bottom, "the last account's reset line clears the scroller edge").toBeLessThanOrEqual(end.cap);
			await expect(notice).toBeInViewport({ ratio: 1 });
			await page.screenshot({ path: test.info().outputPath(`sidebar-usage-${height}-end.png`) });
		}
	} finally {
		await browser.close();
		await server.close();
	}
});
