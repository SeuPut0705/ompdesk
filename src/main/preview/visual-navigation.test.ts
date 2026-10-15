import { describe, expect, it } from "vitest";
import { parseVisualUrl, visualMayNavigate } from "./visual-navigation";

const ID = "0123456789abcdef";

describe("visual navigation policy", () => {
	it("names the visual and version an omp-visual address carries", () => {
		expect(parseVisualUrl(`omp-visual://v3-${ID}/site/index.html`)).toEqual({ id: ID, version: 3 });
		expect(parseVisualUrl(`omp-visual://v3-${ID}`)).toEqual({ id: ID, version: 3 });
		for (const url of [
			`https://v3-${ID}/`,
			`omp-visual://v3-${ID.toUpperCase()}/`,
			`omp-visual://x3-${ID}/`,
			`omp-visual://v3-${ID}0/`,
			`blob:omp-visual://v3-${ID}/uuid`,
			"not a url",
		])
			expect(parseVisualUrl(url)).toBeNull();
	});

	it("lets a visual's page move only within its own visual or to an empty document", () => {
		expect(visualMayNavigate(ID, `omp-visual://v1-${ID}/index.html`)).toBe(true);
		expect(visualMayNavigate(ID, `omp-visual://v9-${ID}/other/page.html?x=1#y`)).toBe(true);
		expect(visualMayNavigate(ID, "about:blank")).toBe(true);
		expect(visualMayNavigate(ID, "about:blank#top")).toBe(true);
		expect(visualMayNavigate(ID, "about:srcdoc")).toBe(true);
		expect(visualMayNavigate(null, "about:blank")).toBe(true);
	});

	it("refuses every other address, whatever it carries", () => {
		for (const url of [
			"https://evil.example/?d=secret",
			"http://127.0.0.1:9/",
			"http://localhost/",
			"ws://evil.example/",
			"file:///etc/passwd",
			"data:text/html,<script>1</script>",
			`blob:omp-visual://v1-${ID}/uuid`,
			"javascript:alert(1)",
			"about:version",
			"chrome://gpu",
			"mailto:a@example.com",
			`omp-visual://v1-fedcba9876543210/index.html`,
			"",
			"not a url",
		])
			expect(visualMayNavigate(ID, url), url).toBe(false);
		// An empty document shows no visual: only another empty document follows.
		expect(visualMayNavigate(null, `omp-visual://v1-${ID}/index.html`)).toBe(false);
	});
});
