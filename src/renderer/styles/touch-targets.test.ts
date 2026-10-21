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

	it("sizes type through the tokens, so the phone's 12 px floor reaches it (a markdown table read 11.3 px)", () => {
		// A size under the body's own steps derived from --gui-font-size skips the phone density block's floor.
		for (const file of ["./components.css", "./global.css", "./mobile.css"]) {
			for (const [, step] of read(file).matchAll(
				/font-size:\s*calc\(var\(--gui-font-size, 15px\) \* ([\d.]+) \/ 15\)/g,
			)) {
				expect(Number(step), `${file}: a ${step}/15 size belongs to a --sc-font-* token`).toBeGreaterThanOrEqual(
					14,
				);
			}
		}
		expect(read("./components.css")).toMatch(/\.markdown-body table \{[^}]*font-size:\s*var\(--sc-font-sm\)/);
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
	it("a phone's bar and the rows a thumb taps one after another are dense (40 px)", () => {
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
	});

	it("a field, which cannot carry the hit area, is drawn 36 px high", () => {
		expect(css).toMatch(/\[type="hidden"\]\), select\) \{\s*min-height:\s*36px/);
	});
});

describe("a session's family rows (sidebar subagents and opened sessions)", () => {
	it("is one 28 px line on a desktop, --sc-row-touch (36 px on a phone) under a finger, and bounds its hit areas", () => {
		expect(read("./sidebar.css")).toMatch(/\.omp-session-sidebar \.omp-family-row \{\s*min-height:\s*28px/);
		expect(css).toMatch(/\.omp-session-sidebar \.omp-family-row[^{]*\{\s*min-height:\s*var\(--sc-row-touch\)/);
		expect(rule('html[data-shell="phone"]')).toMatch(/--sc-row-touch:\s*36px/);
		const bound = rule("html[data-shell] .omp-session-sidebar :is([data-sidebar-family], .omp-family-chip)");
		expect(bound).toMatch(/--hit-gap-x:\s*4px/);
		expect(bound).toMatch(/--hit-gap-y:\s*0px/);
		// The row is one flex line: no description under the title.
		const row = read("../components/layout/sidebar/SidebarFamilyRow.tsx");
		expect(row).toContain("flex w-full items-center");
		expect(row).not.toContain("description");
	});
});

describe("hit areas that fill the room they have", () => {
	it("leaves a compact settings row unbounded: its 44 px reach ends at the row's own edge", () => {
		// The 36 px field row between 4 px paddings is a 44 px pitch; only a stacked row (glyph over control) is bounded.
		expect(rule('html[data-shell="phone"] .settings-content :is([data-setting-row], .settings-field-row)')).toMatch(
			/--hit-gap-y:\s*8px/,
		);
		expect(rule('html[data-shell="phone"] .settings-content .settings-field-row-compact')).toMatch(
			/--hit-gap-y:\s*initial/,
		);
		expect(rule('html[data-shell="phone"]')).toMatch(/--sc-row-touch:\s*36px/);
		expect(read("../components/settings/SettingsLayout.tsx")).toContain('"settings-row scroll-mt-4 py-1"');
	});

	it("lets a terminal key reach through the bar's padding, which its scroller holds so the reach is not clipped", () => {
		// A key's ::after starts inside its 1 px border: 10 px apart and bounded at 10, it fills the bar's height and
		// reaches 36 across an arrow (4 px apart and bounded at 8 left the keys 34 high and the arrows 30 wide).
		const bound = rule("html[data-shell] [data-terminal-keybar],\nhtml[data-shell] [data-terminal-keybar] > div");
		expect(bound).toMatch(/column-gap:\s*10px/);
		expect(bound).toMatch(/--hit-gap-x:\s*10px/);
		expect(bound).toMatch(/--hit-gap-y:\s*10px/);
		// The phone's tab bar under it keeps its reach inside its own 40 px buttons, leaving the keys their bottom edge.
		expect(rule('html[data-shell="phone"] .omp-panel-tabbar > button')).toMatch(/--hit-gap-y:\s*0px/);
		const bar = read("../components/panels/TerminalKeyBar.tsx");
		expect(bar).toContain('bg-(--sc-surface-1) px-2"');
		expect(bar).toContain("overflow-x-auto py-1");
	});
});

describe("controls close enough to take each other's taps", () => {
	// Found by the responsive audit at 390 (stolen-tap): each one's 44 px reach covered its neighbour's.
	const declares = (relative: string, ...bounds: string[]) => {
		const source = read(relative);
		for (const bound of bounds) expect(source, `${relative} declares ${bound}`).toContain(bound);
	};

	it("keeps the flush children-at-work rows inside their own row", () => {
		expect(read("./components.css")).toMatch(
			/:where\(html\[data-input="touch"\]\) \.omp-children-at-work > ul \{\s*--hit-gap-y:\s*0px/,
		);
	});

	it("bounds a segmented tab bar to its 2 px gap, which Tabs marks", () => {
		expect(rule('html[data-input="touch"] [role="tablist"][data-segmented]')).toMatch(/--hit-gap-x:\s*2px/);
		declares("../components/common/Tabs.tsx", "data-segmented={segmented || undefined}");
	});

	it("gives a Run sheet choice row's (i) room for a 36 px reach beside its segments", () => {
		const glyph = rule('html[data-input="touch"] [data-choice-row] > [data-setting-info]');
		expect(glyph).toMatch(/margin-inline-start:\s*12px/);
		expect(glyph).toMatch(/--hit-gap-x:\s*20px/);
		expect(glyph).toMatch(/--hit-gap-y:\s*20px/);
		expect(read("../components/layout/composer/ChoiceRow.tsx")).toContain("items-center gap-2 py-0.5");
	});

	it("spaces a figure header's buttons 10 px apart on touch, each a 36 px target", () => {
		expect(rule('html[data-input="touch"] [data-figure-header]')).toMatch(
			/--hit-gap-x:\s*10px;[^}]*--hit-gap-y:\s*10px/,
		);
		expect(
			rule('html[data-input="touch"] [data-figure-header] :is([data-figure-actions], [data-figure-mode])'),
		).toMatch(/gap:\s*10px/);
	});

	it("gives a schedule's day buttons room for a 36 px reach up and down", () => {
		expect(rule('html[data-input="touch"] div:has(> [data-schedule-day])')).toMatch(
			/row-gap:\s*14px;[^}]*--hit-gap-x:\s*10px;[^}]*--hit-gap-y:\s*14px/,
		);
	});

	it("spaces Settings' button clusters 14 px apart on a phone, where an icon button is 24 px", () => {
		const phone = css.slice(css.indexOf('html[data-shell="phone"]\n\t.settings-content'));
		expect(phone.slice(0, phone.indexOf("}"))).toMatch(/column-gap:\s*14px;[^}]*--hit-gap-x:\s*14px/);
	});

	it("lets a stacked Settings row's buttons reach 7 px up and down on a phone, under the label's info line", () => {
		expect(
			rule(
				'html[data-shell="phone"] .settings-content .settings-field-row:not(.settings-field-row-compact) > .settings-field-control',
			),
		).toMatch(/--hit-gap-y:\s*14px/);
	});

	it("declares the gap of the wrapping rows and clusters the audit found", () => {
		declares("../components/modes/AutopilotConfig.tsx", "data-autopilot-run-actions");
		declares("../components/settings/RemoteSection.tsx", "data-remote-addresses");
		declares("../components/dialogs/BenchmarkDialog.tsx", "data-benchmark-models", "data-benchmark-chips");
		// Room as well as a bound: each reach is its own box plus half the gap, so 4-6 px left them 26-29 px high.
		expect(rule('html[data-input="touch"] [data-autopilot-run-actions]')).toMatch(
			/gap:\s*10px;[^}]*--hit-gap-x:\s*10px;[^}]*--hit-gap-y:\s*10px/,
		);
		expect(rule('html[data-input="touch"] [data-remote-addresses]')).toMatch(/--hit-gap-y:\s*14px/);
		expect(rule('html[data-input="touch"] [data-remote-addresses] > li')).toMatch(/padding-block:\s*7px/);
		expect(rule('html[data-input="touch"] [data-benchmark-models] > :not(:last-child)')).toMatch(
			/margin-block-end:\s*12px/,
		);
		expect(rule('html[data-input="touch"] [data-benchmark-chips]')).toMatch(/gap:\s*12px;[^}]*--hit-gap-y:\s*12px/);
		// A finished work card's findings and copy reach 36 (26 before), staying clear of the steps header and inside the
		// card; the phone Run sheet's Autopilot buttons sit 14 px apart (10 left a phone's 24 px buttons 32).
		expect(rule('html[data-input="touch"] .omp-work-findings')).toMatch(
			/gap:\s*14px 10px;[^}]*margin-top:\s*0;[^}]*--hit-gap-x:\s*10px;[^}]*--hit-gap-y:\s*10px/,
		);
		expect(rule('html[data-input="touch"] .omp-work-findings > .omp-work-cause')).toMatch(/--hit-gap-y:\s*12px/);
		expect(rule('html[data-shell="phone"] .omp-work-findings > .omp-work-copy')).toMatch(/--hit-gap-y:\s*14px/);
		expect(rule('html[data-input="touch"] .omp-work-outcome summary')).toMatch(/min-height:\s*var\(--sc-row-touch\)/);
		expect(rule('html[data-shell="phone"] [data-autopilot-run-actions]')).toMatch(
			/gap:\s*14px;[^}]*--hit-gap-x:\s*14px;[^}]*--hit-gap-y:\s*14px/,
		);
		// A work card's step chips are 36 px taps under any finger (portrait phones and tablets drew 26 × 28).
		expect(rule('html[data-input="touch"] .omp-live-work-chips')).toMatch(
			/gap:\s*12px;[^}]*padding-block:\s*6px;[^}]*margin-block:\s*-6px;[^}]*--hit-gap-x:\s*12px;[^}]*--hit-gap-y:\s*12px/,
		);
		// The goal dock bar: an iPad held sideways handed a tap on Pause's right edge to Edit (8 px apart, unbounded).
		declares("../components/chat/dock/GoalDockBar.tsx", "data-goal-dock");
		expect(rule('html[data-input="touch"] [data-goal-dock]')).toMatch(
			/gap:\s*10px;[^}]*--hit-gap-x:\s*10px;[^}]*--hit-gap-y:\s*12px/,
		);
		// The Autopilot board: Pause, End and Stop now reach 36 from 14 px apart; a section head's copy and a row's own
		// pin or ✕ reach the touch row, never past the board's edge (a docked board scrolled sideways by 2 px).
		declares("../components/autopilot/AutopilotBoard.tsx", "data-autopilot-controls");
		expect(rule('html[data-input="touch"] [data-autopilot-controls]')).toMatch(
			/column-gap:\s*14px;[^}]*row-gap:\s*14px;[^}]*--hit-gap-x:\s*14px;[^}]*--hit-gap-y:\s*14px/,
		);
		expect(rule('html[data-input="touch"] :is(.omp-work-board-row, [data-board-row-actions]) > button')).toMatch(
			/--hit-gap-x:\s*12px;[^}]*--hit-gap-y:\s*10px/,
		);
		expect(rule('html[data-input="touch"] .omp-work-board-title > .omp-work-board-aside')).toMatch(
			/padding-inline-end:\s*8px;[^}]*--hit-gap-x:\s*14px;[^}]*--hit-gap-y:\s*14px/,
		);
		// The Changes view: its 24 px controls behind a 1 px border reach 36 from 14 px apart; a file row's parts are
		// as tall as the row (they drew 26 px with no reach between the flush rows).
		expect(rule('html[data-input="touch"] .omp-changes [data-scm-bar]')).toMatch(/gap:\s*14px/);
		expect(
			rule('html[data-input="touch"] .omp-changes [data-scm-bar][data-scm-bar][data-scm-bar] > div.flex'),
		).toMatch(/column-gap:\s*14px;[^}]*--hit-gap-x:\s*14px;[^}]*--hit-gap-y:\s*14px/);
		expect(
			rule('html[data-input="touch"] .omp-changes [data-staged][data-staged] > :is(label, button:not(:last-child))'),
		).toMatch(/align-self:\s*stretch/);
		// The discard icon keeps its size (a tablet keeps the desktop's controls): only its reach grows.
		const discard = rule('html[data-input="touch"] .omp-changes [data-staged][data-staged] > button:last-child');
		expect(discard).toMatch(/--hit-gap-y:\s*14px/);
		expect(discard).not.toMatch(/\b(width|height):/);
		const topbar = css.lastIndexOf('\nhtml[data-shell="phone"] .omp-panel-topbar {');
		expect(css.slice(topbar, css.indexOf("}", topbar))).toMatch(/--hit-gap-y:\s*14px/);
		// A phone's side-panel icons draw 24 px behind a 1 px border: 14 px apart, bounded at 14, they reach 36.
		const phonePanel = css.indexOf('html[data-shell="phone"][data-input="touch"]\n\t:is([data-sheet-panel]');
		expect(css.slice(phonePanel, css.indexOf("}", phonePanel))).toMatch(
			/column-gap:\s*14px;[^}]*--hit-gap-x:\s*14px;[^}]*--hit-gap-y:\s*14px/,
		);
		declares("../components/panels/TerminalPanel.tsx", "data-terminal-head");
		declares("../components/panels/FilesPanel.tsx", "data-file-viewer-head");
		declares("../components/common/EmptyState.tsx", "data-empty-actions");
		expect(rule('html[data-input="touch"] [data-empty-actions]')).toMatch(/--hit-gap-y:\s*initial/);
		declares("../components/panels/TerminalPanel.tsx", 'touch ? "gap-2.5 [--hit-gap-x:10px]" : "gap-1"');
		declares("../components/dialogs/ImportForeignDialog.tsx", 'touch ? "gap-2.5 [--hit-gap-x:10px]" : "gap-1"');
		// Checkbox and radio rows a few px apart: each a row high, its reach ending half way to the next (a 44 px reach
		// from a 17 px label toggled the row under it).
		declares("../components/dialogs/FeedbackDialog.tsx", "data-feedback-include");
		expect(rule('html[data-input="touch"] [data-feedback-include]')).toMatch(/--hit-gap-y:\s*4px/);
		expect(rule('html[data-input="touch"] [data-feedback-include] :is(label, summary)')).toMatch(
			/padding-block:\s*10px/,
		);
		expect(rule('html[data-input="touch"] [data-feedback-include] [data-setting-info]')).toMatch(
			/--hit-gap-x:\s*20px;[^}]*--hit-gap-y:\s*20px/,
		);
		declares("../components/dialogs/WorktreeDialog.tsx", "data-worktree-base");
		expect(rule('html[data-input="touch"] [data-worktree-base]')).toMatch(/--hit-gap-y:\s*6px/);
		expect(rule('html[data-input="touch"] [data-worktree-base] > label')).toMatch(
			/min-height:\s*var\(--sc-row-touch\)/,
		);
	});
});

describe("the phone composer", () => {
	it("draws +, Send and Stop at 28 px and reaches 44 (18 px of hit gap each way: the reach starts inside the 1 px border)", () => {
		const gap = rule('html[data-shell="phone"] :is(.omp-composer-toolbar, .omp-composer-send-cluster)');
		expect(gap).toMatch(/--hit-gap-x:\s*18px/);
		expect(gap).toMatch(/--hit-gap-y:\s*18px/);
		expect(rule('html[data-shell="phone"] .omp-composer-toolbar [data-send-mode]')).toMatch(/height:\s*28px/);
	});

	it("makes the touch gutter symmetric and the pickers' option rows 44 px", () => {
		expect(touchRoot).toMatch(/--omp-scrollbar-size:\s*0px/);
		expect(rule('html[data-input="touch"] .omp-composer-anchor [role="option"]')).toMatch(
			/min-height:\s*var\(--sc-row-action\)/,
		);
	});

	it("gives the sheets' own rows their touch height", () => {
		// The Run sheet's segmented rows (thinking, approval, delegation) and tiles are one dense line each.
		expect(rule('html[data-input="touch"] [data-choice-row] [role="radio"]')).toMatch(
			/min-height:\s*var\(--sc-row-touch\)/,
		);
		expect(rule('html[data-input="touch"] [data-switch-tile]')).toMatch(/min-height:\s*var\(--sc-row-touch\)/);
		expect(read("../components/layout/composer/ContextUsagePopover.tsx")).toContain("min-h-(--sc-row-action)");
	});
});
