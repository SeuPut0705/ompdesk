/**
 * Captures of the session reports (`ompdesk.mail`) in a transcript on the dev harness (`?mail=1`): a progress and a
 * done report closed to one line, a question open with its warning tint, then the done report opened from the
 * keyboard. Opt-in: registers only with `OMP_GUI_MAIL_COLLAPSE=<dir>` (en/ko × light/dark × desktop/390). The
 * behaviour is pinned by `MailNote.test.tsx` and `CustomMessageCard.test.tsx`; `agent-mail.e2e.ts` runs it on the app.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const CAPTURES = process.env.OMP_GUI_MAIL_COLLAPSE;

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser | undefined;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		const port = typeof address === "object" && address ? address.port : 0;
		probe.close(() => resolve(port));
	});
	return promise;
}

const SURFACES = [
	{ name: "390", context: { ...devices["iPhone 15"], viewport: { width: 390, height: 844 } } },
	{ name: "desktop", context: { viewport: { width: 1280, height: 860 } } },
] as const;

if (CAPTURES) {
	test.beforeAll(async () => {
		const port = await freePort();
		server = await createServer({
			configFile: path.resolve("vite.harness.config.ts"),
			server: { host: "127.0.0.1", port, strictPort: true },
			logLevel: "error",
		});
		await server.listen();
		origin = `http://127.0.0.1:${port}`;
		browser = await chromium.launch();
		await fs.mkdir(CAPTURES, { recursive: true });
	});

	test.afterAll(async () => {
		await browser?.close();
		await server?.close();
	});

	for (const surface of SURFACES)
		for (const theme of ["light", "dark"] as const)
			for (const lang of ["en", "ko"] as const)
				test(`session reports fold to one line (${surface.name} ${theme} ${lang})`, async () => {
					if (!browser) throw new Error("no browser");
					const context = await browser.newContext(surface.context);
					const page = await context.newPage();
					await page.goto(`${origin}/harness.html?mail=1&theme=${theme}&lang=${lang}`);
					const question = page.locator("[data-agent-mail='question']");
					await expect(question).toBeVisible({ timeout: 45_000 });
					await expect(question.locator("[data-agent-mail-body]")).toBeVisible();
					const done = page.locator("[data-agent-mail='done']");
					await expect(done.locator("[data-agent-mail-body]")).toHaveCount(0);
					await expect(page.locator("[data-agent-mail='progress'] [data-agent-mail-body]")).toHaveCount(0);
					await done.scrollIntoViewIfNeeded();
					const shot = (state: string) =>
						page.screenshot({ path: path.join(CAPTURES, `${surface.name}-${state}-${theme}-${lang}.png`) });
					await shot("closed");
					await done.locator("button[aria-expanded]").focus();
					await page.keyboard.press("Space");
					await expect(done.locator("[data-agent-mail-body]")).toBeVisible();
					await done.scrollIntoViewIfNeeded();
					await shot("opened");
					await context.close();
				});
}
