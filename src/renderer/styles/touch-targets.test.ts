import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A finger needs 44 px of hit area, a phone UI needs dense visuals: controls keep their desktop size and type
// steps, and `html[data-input="touch"]` in mobile.css only adds an invisible ::after that reaches
// `--sc-touch-target`. The web build never reaches the desktop rules (they stay byte for byte).
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");
const css = read("./mobile.css");
const rule = (selector: string): string => {
	const start = css.indexOf(`\n${selector} {`);
	if (start < 0) return "";
	return css.slice(start, css.indexOf("}", start));
};
const touchRoot = rule('html[data-input="touch"]');

describe("touch targets and type", () => {
	it("keeps the control, icon and type tokens at the desktop sizes on touch and on a tablet", () => {
		// Only the phone shell shrinks them (the "Phone density" block); `data-input="touch"` and a tablet never do.
		expect(touchRoot).not.toMatch(/--sc-(control|icon|font|hit)/);
		const sizeRule = /\n[^\n{}]*\{[^}]*--sc-(control-(sm|md|lg)|hit-min|icon-|font-(2xs|xs|sm|md|lg)):[^}]*\}/g;
		for (const [block] of css.matchAll(sizeRule)) {
			expect(block.trimStart().startsWith('html[data-shell="phone"] {')).toBe(true);
		}
		expect(read("./tokens.css")).toMatch(/--sc-control-sm: 28px;/);
		expect(read("./tokens.css")).toMatch(/--sc-hit-min: 28px;/);
		expect(read("./tokens.css")).toMatch(/--sc-font-xs: calc\(var\(--gui-font-size, 15px\) \* 12 \/ 15\)/);
		expect(read("./tokens.css")).toMatch(/--sc-font-sm: calc\(var\(--gui-font-size, 15px\) \* 13 \/ 15\)/);
	});

	it("shrinks the phone's controls, type and icons in one place, with fields still 16 px", () => {
		const phone = rule('html[data-shell="phone"]');
		expect(phone).toMatch(/--sc-control-sm:\s*24px/);
		expect(phone).toMatch(/--sc-control-md:\s*28px/);
		expect(phone).toMatch(/--sc-control-lg:\s*32px/);
		expect(phone).toMatch(/--phone-type-scale:\s*0\.8667/);
		expect(read("../lib/theme.ts")).toContain("var(--phone-type-scale, 1)");
		expect(phone).toMatch(/--sc-font-xs:\s*12px/);
		expect(css).toMatch(/html\[data-input="touch"\] :is\(input:[^{]*\{\s*font-size:\s*16px/);
	});

	it("names the 44 px hit area and dense rows as tokens", () => {
		expect(touchRoot).toMatch(/--sc-touch-target:\s*44px/);
		expect(touchRoot).toMatch(/--sc-row-touch:\s*40px/);
		expect(touchRoot).toMatch(/--sc-row-action:\s*44px/);
	});

	it("reaches the hit area with an invisible ::after on switches, chips, ⋯, icon buttons, tabs and checkboxes", () => {
		const hit = css.slice(css.indexOf("@layer base {", css.indexOf("a finger-sized hit area")));
		expect(hit).toMatch(/\[role="switch"\]/);
		expect(hit).toMatch(/\[data-setting-info\]/);
		expect(hit).toMatch(/label:has\(> input:is\(\[type="checkbox"\], \[type="radio"\]\)\)/);
		expect(hit).toMatch(/::after\s*\{\s*content: "";\s*position: absolute;/);
		expect(hit).toMatch(
			/inset-block:\s*max\(\s*min\(0px, calc\(\(100% - var\(--sc-touch-target\)\) \/ 2\)\),\s*calc\(var\(--hit-gap-y, 200vmax\) \/ -2\)\s*\)/,
		);
		expect(hit).toMatch(
			/inset-inline:\s*max\(\s*min\(0px, calc\(\(100% - var\(--sc-touch-target\)\) \/ 2\)\),\s*calc\(var\(--hit-gap-x, 200vmax\) \/ -2\)\s*\)/,
		);
		// It sits in the base layer so an element's own ::after or a positioning utility still wins.
		expect(hit.startsWith("@layer base {")).toBe(true);
	});

	it("makes no visible size 44 px: no switch width, chip height, bar button or checkbox label minimum", () => {
		expect(css).not.toMatch(/\[role="switch"\]\s*\{[^}]*min-width/);
		expect(css).not.toMatch(/\.omp-live-work-chip\s*\{[^}]*(height|width)/);
		expect(css).not.toMatch(/\[data-setting-info\]\s*\{[^}]*min-(width|height)/);
		expect(css).not.toMatch(/label:has\([^{]*\{[^}]*min-height/);
		expect(css).not.toMatch(/:is\(\.omp-topbar[^{]*button\s*\{/);
		expect(css).not.toMatch(/min-height:\s*(48|52|56)px/);
	});

	it("keeps the dock toggle and the jump-to-latest pill at their desktop size", () => {
		expect(read("../components/chat/dock/DockCard.tsx")).not.toContain("data-input=touch");
		expect(read("../components/chat/ChatStream.tsx")).not.toContain("data-input=touch");
	});

	it("gives each changed file a checkbox in a label that the hit area reaches", () => {
		const source = read("../components/panels/RepositoryChanges.tsx");
		expect(source).toMatch(/<label className="[^"]*h-\(--sc-hit-min\)[^"]*">\s*<input\s+aria-checked/);
	});
});

describe("the prompt card on touch", () => {
	it("keeps the answers, the step tabs and Add a note one dense row each, and each carries its hook", () => {
		expect(
			rule('html[data-input="touch"] :is([data-choice-list] > button, [data-ask-step], [data-ask-note])'),
		).toMatch(/min-height:\s*var\(--sc-row-touch\)/);
		expect(read("../components/dialogs/PromptCard.tsx")).toContain("data-choice-list");
		const ask = read("../components/dialogs/ExtensionDialog.tsx");
		expect(ask).toContain("data-ask-step={index}");
		expect(ask).toContain("data-ask-note");
	});
});

describe("rows and bars on touch", () => {
	it("a phone's bar and the rows a thumb taps one after another are dense (40 px), a sheet's items 44", () => {
		expect(rule('html[data-shell="phone"] .omp-topbar')).toMatch(/height:\s*36px/);
		for (const row of [
			'\\[role="menuitem"\\]',
			"\\.omp-session-sidebar \\[data-session-row\\]",
			"\\.omp-session-sidebar \\[data-workspace-group\\]",
			"\\.omp-session-sidebar \\[data-destination\\]",
			"\\.omp-list-row",
			"\\.settings-field-row",
		]) {
			expect(css).toMatch(new RegExp(`${row}[^{]*\\{\\s*min-height:\\s*var\\(--sc-row-touch\\)`));
		}
		expect(rule(".omp-action-sheet [data-menu-item]")).toMatch(/min-height:\s*var\(--sc-row-action\)/);
	});

	it("a field, which cannot carry the hit area, is drawn 36 px high", () => {
		expect(css).toMatch(/\[type="hidden"\]\), select\) \{\s*min-height:\s*36px/);
	});
});
