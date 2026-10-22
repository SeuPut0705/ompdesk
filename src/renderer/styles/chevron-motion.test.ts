import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

// Tailwind 4's `rotate-90` sets the `rotate` property, not `transform`, so a chevron class that eases only
// `transform` flips without motion when the row opens.
const CHEVRONS = ["omp-disclosure-chevron", "omp-work-card-chevron"];

function transitionsOf(css: string, className: string): string[] {
	const found: string[] = [];
	for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selector = match[1] ?? "";
		if (!new RegExp(`\\.${className}\\s*(,|$)`).test(selector.trim())) continue;
		for (const declaration of (match[2] ?? "").matchAll(/transition(?:-property)?\s*:\s*([^;]+)/g)) {
			found.push((declaration[1] ?? "").trim());
		}
	}
	return found;
}

describe("disclosure chevrons", () => {
	const css = ["./global.css", "./components.css"].map(read).join("\n");
	for (const className of CHEVRONS) {
		it(`.${className} eases the rotate that rotate-90 sets`, () => {
			const transitions = transitionsOf(css, className).filter(value => value !== "none");
			expect(transitions.length).toBeGreaterThan(0);
			for (const value of transitions) expect(value).toMatch(/\brotate\b/);
		});
	}
});
