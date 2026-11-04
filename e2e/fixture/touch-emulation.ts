import { expect, type Page } from "@playwright/test";

/**
 * Send Chromium's touch emulation to a phone page again, after the harness has loaded into it (the app then re-reads
 * `(pointer: coarse)` on the media change).
 *
 * Hosted runners have given a Chromium page of an `iPhone 15` / `Pixel 8` context no touch at all: `(pointer: coarse)`
 * false, `navigator.maxTouchPoints` 0, so the app read `data-input="mouse"` and drew its 24 px desktop controls
 * (nightlies 41880669356 mobile-composer, 41891147987 mobile-suggestions, 41902079883 and 41916393486 mobile-pages,
 * 41921143051 responsive-smoke and mobile-shell; never seen locally). Sending it before the navigation did not help
 * (41931516185: pixel8 still read 0 touch points), so it is sent once the page has loaded. Playwright sends
 * `Emulation.setTouchEmulationEnabled` once per page and Chromium is known to drop that state
 * (microsoft/playwright#42607); only sending it again brings it back. A workaround for a browser defect, not a
 * retry, and not shown to work until the nightlies after it hold.
 */
export async function reassertTouch(page: Page): Promise<void> {
	const context = page.context();
	if (context.browser()?.browserType().name() !== "chromium") return;
	// The session stays attached for the page's life: Chromium keeps an emulation override with the session that set it.
	const session = await context.newCDPSession(page);
	await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
}

/**
 * A touch page must read `data-input="touch"`; when it does not, fail naming what the browser says about touch instead
 * of a size check far from the cause (24 or 36 px controls where 44 were meant).
 */
export async function expectTouchInput(page: Page): Promise<void> {
	await expect(page.locator("html"))
		.toHaveAttribute("data-input", "touch")
		.catch(async (error: Error) => {
			const media = await page.evaluate(() => ({
				coarse: matchMedia("(pointer: coarse)").matches,
				hoverNone: matchMedia("(hover: none)").matches,
				maxTouchPoints: navigator.maxTouchPoints,
			}));
			throw new Error(`${error.message}\nthe browser now says ${JSON.stringify(media)}`);
		});
}
