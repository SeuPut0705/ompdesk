import type { Page } from "@playwright/test";

/**
 * Send Chromium's touch emulation to a phone page again, before the app loads into it.
 *
 * Hosted runners have given a Chromium page of an `iPhone 15` / `Pixel 8` context no touch at all: `(pointer: coarse)`
 * false, `navigator.maxTouchPoints` 0, so the app read `data-input="mouse"` and drew its 24 px desktop controls
 * (nightlies 41880669356 mobile-composer, 41891147987 mobile-suggestions, 41902079883 and 41916393486 mobile-pages;
 * never seen locally).
 * Playwright sends `Emulation.setTouchEmulationEnabled` once per page, and Chromium is known to drop that state
 * (microsoft/playwright#42607: after a beyond-viewport capture, and only `setTouchEmulationEnabled` brings it back).
 * Sending it again with the value `hasTouch` already means changes nothing when the emulation is intact. A workaround
 * for a browser defect, not a retry: it is not shown to fix these failures until the nightlies after it hold.
 */
export async function reassertTouch(page: Page): Promise<void> {
	const context = page.context();
	if (context.browser()?.browserType().name() !== "chromium") return;
	const session = await context.newCDPSession(page);
	await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
	await session.detach();
}
