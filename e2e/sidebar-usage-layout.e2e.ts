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
test("the narrow sidebar shows all three accounts and resets together above Settings", async () => {
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
		await page.goto(`http://127.0.0.1:${port}/harness.html?theme=dark&lang=ko&usage=blocked&platform=darwin`);
		const block = page.locator("[data-rail-pin='usage']");
		const scroller = page.locator("[data-sidebar-usage-scroll]");
		await expect(block.locator("[data-usage-account]")).toHaveCount(3);
		await expect(block.locator("[data-in-use]")).toHaveCount(1);
		await expect(block.getByRole("progressbar")).toHaveCount(8);
		await expect(block.locator(".omp-usage-gauge-reset")).toHaveCount(8);
		for (const height of [860, 560]) {
			await page.setViewportSize({ width: 1280, height });
			const geometry = await block.evaluate(element => {
				const box = element.getBoundingClientRect();
				const sidebar = document.querySelector(".omp-session-sidebar")?.getBoundingClientRect();
				const list = document.querySelector(".omp-sidebar-list")?.getBoundingClientRect();
				const settings = document.querySelector("[data-destination='settings']")?.getBoundingClientRect();
				const scroller = element.querySelector("[data-sidebar-usage-scroll]")?.getBoundingClientRect();
				return {
					height: box.height,
					width: sidebar?.width,
					listHeight: list?.height,
					settingsTop: settings?.top,
					bottom: box.bottom,
					minimumFont: Math.min(
						...[
							...element.querySelectorAll("[data-account-label], .omp-usage-gauge-text, .omp-usage-gauge-reset"),
						].map(cell => Number.parseFloat(getComputedStyle(cell).fontSize)),
					),
					visibleAccounts: [...element.querySelectorAll("[data-usage-account]")].filter(row => {
						const rect = row.getBoundingClientRect();
						return scroller && rect.top >= scroller.top && rect.bottom <= scroller.bottom;
					}).length,
				};
			});
			expect(geometry.width).toBe(227);
			expect(geometry.height, "the whole usage block takes at most a third").toBeLessThanOrEqual(height / 3);
			expect(geometry.listHeight, "session rows retain at least a quarter of the sidebar").toBeGreaterThan(
				height / 4,
			);
			expect(geometry.bottom, "all account data stays above Settings").toBeLessThan(geometry.settingsTop ?? 0);
			expect(geometry.visibleAccounts, "all three accounts are readable without scrolling").toBe(3);
			expect(geometry.minimumFont, "values and resets retain readable type").toBeGreaterThanOrEqual(12);
			// Every window's label, percentage and reset remain readable at this width.
			const cut = await block.locator(".omp-usage-gauge-text, .omp-usage-gauge-reset").evaluateAll(
				elements =>
					elements.filter(element => {
						const range = document.createRange();
						range.selectNodeContents(element);
						const text = range.getBoundingClientRect();
						const box = element.getBoundingClientRect();
						const style = getComputedStyle(element);
						return (
							text.left < box.left + Number.parseFloat(style.paddingLeft) - 0.5 ||
							text.right > box.right - Number.parseFloat(style.paddingRight) + 0.5 ||
							text.top < box.top + Number.parseFloat(style.paddingTop) - 0.5 ||
							text.bottom > box.bottom - Number.parseFloat(style.paddingBottom) + 0.5
						);
					}).length,
			);
			expect(cut, "no window label, percentage or reset is cut").toBe(0);
			await test.info().attach(`geometry-${height}`, {
				body: JSON.stringify({ viewportHeight: height, ...geometry, cut }),
				contentType: "application/json",
			});
			expect(await scroller.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
			const last = block.locator("[data-usage-account]").last();
			await expect(last).toHaveAttribute("aria-label", "taylor.r@example.com");
			await expect(last.locator(".omp-usage-gauge-reset")).toHaveCount(3);
			const end = await last.evaluate(element => {
				const box = element.getBoundingClientRect();
				const list = element.closest("[data-sidebar-usage-scroll]")?.getBoundingClientRect();
				return { bottom: box.bottom, cap: list?.bottom ?? 0 };
			});
			expect(end.bottom, "the last account's reset line clears the scroller edge").toBeLessThanOrEqual(end.cap);
			await page.screenshot({ path: test.info().outputPath(`sidebar-usage-${height}-end.png`) });
		}
		await page.goto(`http://127.0.0.1:${port}/harness.html?theme=dark&lang=ko&usage=windows&platform=darwin`);
		await expect(block.getByRole("progressbar")).toHaveCount(14);
		await expect(block.locator(".omp-usage-gauge-reset")).toHaveCount(14);
		const wideLast = block.locator("[data-usage-account]").last();
		await wideLast.scrollIntoViewIfNeeded();
		const identities = await wideLast.locator(".omp-usage-gauge").evaluateAll(cells =>
			cells.map(cell => {
				const label = cell.querySelector("[data-usage-label]");
				const value = cell.querySelector("[data-usage-percent]");
				const labelBox = label?.getBoundingClientRect();
				const valueBox = value?.getBoundingClientRect();
				const box =
					cell.querySelector(".omp-usage-gauge-bar")?.getBoundingClientRect() ?? cell.getBoundingClientRect();
				return {
					label: label?.textContent,
					value: value?.textContent,
					connected: Boolean(
						labelBox &&
							valueBox &&
							labelBox.bottom <= valueBox.top + 0.5 &&
							labelBox.top >= box.top &&
							valueBox.bottom <= box.bottom &&
							labelBox.left >= box.left &&
							labelBox.right <= box.right &&
							valueBox.left >= box.left &&
							valueBox.right <= box.right,
					),
				};
			}),
		);
		expect(identities.map(({ label, value }) => [label, value])).toEqual([
			["5H", "4%"],
			["7D", "31%"],
			["Fable", "22%"],
			["Opus", "25%"],
			["Sonnet", "50%"],
		]);
		expect(
			identities.every(cell => cell.connected),
			"every wrapped window keeps its own title above its value",
		).toBe(true);
		await page.screenshot({ path: test.info().outputPath("sidebar-usage-five-windows.png") });

		await page.goto(
			`http://127.0.0.1:${port}/harness.html?theme=dark&lang=ko&usage=figures&platform=darwin&rail=all`,
		);
		await page.locator('button[data-destination="insights"]').click();
		await page.getByRole("tab", { name: "사용량", exact: true }).click();
		await expect(page.locator('[data-usage-fact="usage.note.overageBalance"] dd')).toHaveText("$12.50");
		await expect(page.locator('[data-usage-fact="usage.note.overageRequests"] dd')).toHaveText("17");
		await expect(page.getByRole("tab", { name: "사용량", exact: true })).toHaveAttribute("aria-selected", "true");
		await page.evaluate(async () => {
			await Promise.all(
				document
					.getAnimations()
					.filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
					.map(animation => animation.finished.catch(() => undefined)),
			);
			const frame = Promise.withResolvers<void>();
			requestAnimationFrame(() => frame.resolve());
			await frame.promise;
		});
		await page.screenshot({ path: test.info().outputPath("usage-note-figures.png") });
	} finally {
		await browser.close();
		await server.close();
	}
});
