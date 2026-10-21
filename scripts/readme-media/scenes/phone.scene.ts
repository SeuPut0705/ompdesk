/**
 * Phone (390 px): a running session on the mobile web layout, a steering message sent to it, and Settings › Mobile
 * web with the device's own notification opt-in. No paired host exists in a script (the real page needs Tailscale),
 * so this is the web client's renderer on the dev harness (`src/renderer/dev-harness`, a fixture transport) in
 * Chromium at 390 x 844, 2x. `window.__harness.emit` plays the running turn.
 */
import * as path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { createServer } from "vite";
import { Recorder } from "../lib";

const WIDTH = 390;
const HEIGHT = 844;
const STEER = "Also check it in dark mode.";

const assistant = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
	provider: "fixture",
	model: "local-fixture",
});

test("phone steer and push opt-in", async () => {
	const server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port: 0, strictPort: false },
		logLevel: "error",
	});
	await server.listen();
	const address = server.httpServer?.address();
	const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 5199}`;
	const browser = await chromium.launch();
	const context = await browser.newContext({
		viewport: { width: WIDTH, height: HEIGHT },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
	});
	const page = await context.newPage();
	const recorder = new Recorder("phone", { width: WIDTH, height: HEIGHT, maxHold: 1_400, endHold: 2_500 });
	try {
		await page.goto(`${origin}/harness.html?theme=light&lang=en&pwa=push`);
		await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 60_000 });
		await recorder.reset();
		await recorder.attach(page);
		await page.waitForTimeout(1_000);

		// The session is running: a streamed reply and the working status.
		await page.evaluate(() => {
			const harness = window.__harness;
			const status = { tabId: "tab-1", status: "running", cwd: "/Users/dev/projects/ompdesk", sessionId: "sess-1" };
			harness?.emit("tab:status", status);
			harness?.emit("rpc:events", { tabId: "tab-1", payload: [{ type: "agent_start" }] });
		});
		await page.waitForTimeout(1_200);
		// Steer it.
		const input = page.locator("textarea").first();
		await input.tap();
		await page.keyboard.type(STEER, { delay: 45 });
		await page.waitForTimeout(500);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(1_800);
		// The agent takes the steer and finishes.
		await page.evaluate(
			([message]) => {
				const harness = window.__harness;
				harness?.emit("rpc:events", {
					tabId: "tab-1",
					payload: [
						{ type: "message_end", message },
						{ type: "agent_end", messages: [message] },
					],
				});
				harness?.emit("tab:status", {
					tabId: "tab-1",
					status: "ready",
					cwd: "/Users/dev/projects/ompdesk",
					sessionId: "sess-1",
				});
			},
			[assistant("Done. The sidebar test passes in light and dark mode.")] as const,
		);
		await page.waitForTimeout(2_000);

		// Settings › Devices & connections › Mobile web: this device's notification opt-in.
		await page.locator("header button:has(svg.lucide-menu)").tap();
		await page.waitForTimeout(700);
		await page
			.getByRole("button", { name: /^Settings/ })
			.first()
			.tap();
		await page.waitForTimeout(900);
		await page.getByText("Devices & connections").first().tap();
		await page.waitForTimeout(900);
		const notifications = page.locator("[data-web-device-section]");
		await expect(notifications).toBeVisible({ timeout: 15_000 });
		await notifications.evaluate(element => element.scrollIntoView({ block: "start", behavior: "smooth" }));
		await page.waitForTimeout(1_200);
		await page.waitForTimeout(2_800);
		await recorder.finish({ width: WIDTH * 2 });
	} finally {
		await recorder.detach();
		await browser.close();
		await server.close();
	}
});
