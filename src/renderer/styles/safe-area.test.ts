import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The phone's bottom edge (gesture bar, 3-button nav, home indicator) is reached only if the page asks for the
// whole screen, sizes the app to the dynamic viewport and pads every bottom-anchored surface by the inset.
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");
const css = read("./mobile.css");
const rule = (selector: string): string => {
	const start = css.indexOf(`\n${selector} {`);
	if (start < 0) return "";
	return css.slice(start, css.indexOf("}", start));
};

describe("safe areas", () => {
	it.each(["web.html", "harness.html"])("%s asks for the full screen and a keyboard that resizes the layout", file => {
		const html = read(`../${file}`);
		expect(html).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
		expect(html).toContain("interactive-widget=resizes-content");
	});

	it("installs standalone and leaves rotation to the system setting", () => {
		const manifest = JSON.parse(read("../public/manifest.webmanifest")) as { display: string; orientation?: string };
		expect(manifest.display).toBe("standalone");
		// "any" makes Android's WebAPK rotate with the sensor even when the user locked rotation.
		expect(manifest.orientation).toBeUndefined();
	});

	it("sizes the app root to the body, not to 100vh (the large viewport on a phone)", () => {
		expect(read("../App.tsx")).toContain('className="omp-app-root ');
		expect(rule("html[data-shell] .omp-app-root")).toMatch(/height:\s*100%/);
	});

	it("pads the composer, the panel tab bar, sheets and the drawer by the bottom inset", () => {
		expect(rule("html[data-shell] .omp-composer-region.pb-3")).toContain("var(--safe-b)");
		expect(rule(".omp-panel-tabbar")).toContain("var(--safe-b)");
		expect(rule(".omp-action-sheet")).toContain("var(--safe-b)");
		expect(rule("html[data-shell] .omp-sheet-surface")).toContain("var(--safe-b)");
		expect(rule(".omp-drawer > .omp-drawer-panel")).toContain("var(--safe-b)");
		expect(rule('html[data-shell="phone"] .omp-dialog-panel.omp-dialog-panel--sheet')).toContain("var(--safe-b)");
	});

	it("ends fixed overlays at the keyboard and keeps them off the side insets", () => {
		for (const selector of [
			"html[data-shell] [data-sheet-placement]",
			".omp-action-sheet-overlay",
			'html[data-shell="phone"] .omp-dialog-overlay',
		]) {
			const body = rule(selector);
			expect(body).toContain("var(--kb-inset)");
			expect(body).toContain("var(--safe-l)");
			expect(body).toContain("var(--safe-r)");
		}
	});

	it("lifts toasts, prompt fallbacks and banners clear of the insets", () => {
		expect(rule("html[data-shell] .omp-toast-stack")).toContain("var(--safe-t)");
		expect(rule("html[data-shell] .omp-toast-stack")).toContain("var(--safe-r)");
		expect(rule("html[data-shell] .omp-prompt-dock")).toContain("var(--safe-b)");
		expect(rule("html[data-shell] .omp-widget-float")).toContain("var(--safe-b)");
		expect(read("../web/connection-banner.ts")).toContain("safe-area-inset-top");
		expect(read("../web/connection-banner.ts")).toContain("safe-area-inset-left");
	});
});
