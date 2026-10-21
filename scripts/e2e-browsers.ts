/**
 * The phone and web specs launch Playwright's own browsers (`chromium`, `webkit` from `@playwright/test`). A
 * Playwright upgrade moves the browsers' versioned folders, and until `bunx playwright install` fetches them every
 * such spec fails at its launch with the same "Executable doesn't exist" box. `check:changed` asks first, so a
 * missing browser is one line before the build instead of a failed spec per browser and device.
 */
import { chromium, firefox, webkit } from "@playwright/test";

export type BrowserName = "chromium" | "firefox" | "webkit";

const TYPES = { chromium, firefox, webkit } as const;
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']@playwright\/test["']/g;

/** The Playwright browsers a spec's source imports from `@playwright/test`, in a fixed order. */
export function browsersNeeded(source: string): BrowserName[] {
	const named = new Set<string>();
	for (const match of source.matchAll(IMPORT)) {
		for (const part of (match[1] ?? "").split(",")) {
			const name = part.trim();
			if (!name.startsWith("type ")) named.add(name.split(/\s+as\s+/)[0] ?? name);
		}
	}
	return (Object.keys(TYPES) as BrowserName[]).filter(name => named.has(name));
}

/** The browsers among `names` Playwright cannot start because their executable is not installed. */
export async function missingBrowsers(names: readonly BrowserName[]): Promise<BrowserName[]> {
	const missing: BrowserName[] = [];
	for (const name of names) {
		try {
			const browser = await TYPES[name].launch();
			await browser.close();
		} catch (error) {
			// Any other launch failure is the spec's to report.
			if (String((error as Error)?.message).includes("Executable doesn't exist")) missing.push(name);
		}
	}
	return missing;
}
