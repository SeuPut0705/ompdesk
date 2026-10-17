import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A finger needs 44 px and type no smaller than 12–14 px: the controls that own their size in components.css,
// work-board.css or the markup are lifted under `html[data-input="touch"]` in mobile.css; the web build never
// reaches the desktop rules (they stay byte for byte).
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");
const css = read("./mobile.css");
const rule = (selector: string): string => {
	const start = css.indexOf(`\n${selector} {`);
	if (start < 0) return "";
	return css.slice(start, css.indexOf("}", start));
};

describe("touch targets and type", () => {
	it("makes the work chips, the board's rows and fold, and a checkbox label 44 px", () => {
		expect(rule('html[data-input="touch"] .omp-live-work-chip')).toMatch(/height:\s*var\(--sc-hit-min\)/);
		expect(rule('html[data-input="touch"] :is(.omp-work-board-fold, button.omp-work-board-row)')).toMatch(
			/min-height:\s*var\(--sc-hit-min\)/,
		);
		expect(rule('html[data-input="touch"] label:has(> input:is([type="checkbox"], [type="radio"]))')).toMatch(
			/min-height:\s*var\(--sc-hit-min\)/,
		);
		expect(css).toMatch(/html\[data-input="touch"\] \{\s*--sc-control-sm: 44px;/);
	});

	it("steps the small type tokens up on touch and leaves the body steps alone", () => {
		const block = css.slice(css.lastIndexOf('html[data-input="touch"] {'));
		expect(block).toMatch(/--sc-font-xs:\s*calc\(var\(--gui-font-size, 15px\) \* 13 \/ 15\)/);
		expect(block).toMatch(/--sc-font-sm:\s*calc\(var\(--gui-font-size, 15px\) \* 14 \/ 15\)/);
		expect(block).not.toMatch(/--sc-font-(md|lg)/);
	});

	it("lifts the dock toggle and the jump-to-latest pill to the hit size on touch only", () => {
		expect(read("../components/chat/dock/DockCard.tsx")).toContain("[html[data-input=touch]_&]:min-h-(--sc-hit-min)");
		expect(read("../components/chat/ChatStream.tsx")).toContain("[html[data-input=touch]_&]:h-(--sc-hit-min)");
	});

	it("gives each changed file a checkbox in a hit-sized label", () => {
		const source = read("../components/panels/RepositoryChanges.tsx");
		expect(source).toMatch(/<label className="[^"]*h-\(--sc-hit-min\)[^"]*">\s*<input\s+aria-checked/);
	});
});

describe("the prompt card on touch", () => {
	it("lifts the answers, the step tabs and Add a note to the hit size, and each carries its hook", () => {
		expect(
			rule('html[data-input="touch"] :is([data-choice-list] > button, [data-ask-step], [data-ask-note])'),
		).toMatch(/min-height:\s*var\(--sc-hit-min\)/);
		expect(read("../components/dialogs/PromptCard.tsx")).toContain("data-choice-list");
		const ask = read("../components/dialogs/ExtensionDialog.tsx");
		expect(ask).toContain("data-ask-step={index}");
		expect(ask).toContain("data-ask-note");
	});
});
