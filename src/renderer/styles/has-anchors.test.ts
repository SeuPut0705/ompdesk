import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Blink keeps one invalidation set for every `:has()` that stands left of a descendant: whenever a node is inserted
// under an element such a rule matched against (its "anchor"), every descendant of the anchor that any of those rules
// names is restyled. With the shell root and the session pane as anchors and `.flex` in the set, each line a running
// command printed restyled ~150 elements (live-session audit, 27 Oct 2026). Ancestors of streaming output therefore
// carry a mark the rules read instead of a `:has()`.
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");
const css = ["./global.css", "./components.css", "./mobile.css"].map(read).join("\n");

describe("no :has() anchors on what holds streaming output (perf: a restyle per streamed line)", () => {
	it("reads the shell's docked panel from data-panel, which AppShell sets", () => {
		expect(css).not.toMatch(/\.omp-shell[^{,]*:has\(/);
		expect(css).toContain(".omp-shell:not([data-panel]) .omp-topbar,");
		expect(css).toContain('.omp-shell[data-panel="left"] .omp-topbar {');
		expect(read("../components/layout/AppShell.tsx")).toContain("data-panel={panelDocked ? panelSide : undefined}");
	});

	it("reads the pane's status strip from data-work-board-strip, which the strip sets", () => {
		expect(css).not.toMatch(/\.omp-session-pane[^{,]*:has\(/);
		expect(css.match(/\.omp-session-pane\[data-work-board-strip\] :is\(/g)).toHaveLength(2);
	});

	it("finds the side panel's sheet by data-sheet-kind, which both of the panel's sheets set", () => {
		expect(css).not.toContain("[data-sheet-panel]:has(");
		expect(css).toContain(
			'html[data-input="touch"]\n\t:is([data-sheet-kind="panel"], [data-view-sheet], .omp-inspector)',
		);
		expect(read("../components/layout/PanelContainer.tsx").match(/\bkind="panel"/g)).toHaveLength(2);
		expect(read("../components/common/Sheet.tsx")).toContain("data-sheet-kind={kind}");
	});
});
