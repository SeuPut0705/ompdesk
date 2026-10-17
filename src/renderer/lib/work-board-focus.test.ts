import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import { focusWorkBoard } from "./work-board-focus";

const { document, HTMLElement } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;

let focused: Element | null = null;
HTMLElement.prototype.focus = function (this: Element) {
	focused = this;
};

afterEach(() => {
	document.body.innerHTML = "";
	focused = null;
});

/** Two panes, each with a board; the second pane is the focused one. */
function panes(activeBoard: string): void {
	document.body.innerHTML = `
		<div class="omp-session-pane" data-active="false">
			<aside data-work-board-panel id="other"><button data-board-waiting="q0" id="other-waiting">Waiting</button></aside>
		</div>
		<div class="omp-session-pane" data-active="true">
			<aside data-work-board-panel id="board" tabindex="-1">${activeBoard}</aside>
		</div>`;
}

describe("focusWorkBoard (⌥B)", () => {
	it("lands on the focused pane's first row that waits on the user, ahead of the rows above it", () => {
		panes(`<button>Fold</button><button class="omp-work-board-row" id="agent">Agent</button>
			<button data-board-waiting="q1" id="waiting">Question</button>`);
		expect(focusWorkBoard()).toBe(true);
		expect(focused?.id).toBe("waiting");
	});

	it("falls back to its first row, then its first button, then the board itself", () => {
		panes(`<button id="fold">Fold</button><button class="omp-work-board-row" id="agent">Agent</button>`);
		focusWorkBoard();
		expect(focused?.id).toBe("agent");
		panes(`<button id="fold">Fold</button>`);
		focusWorkBoard();
		expect(focused?.id).toBe("fold");
		panes("");
		focusWorkBoard();
		expect(focused?.id).toBe("board");
	});

	it("uses any board when no pane is focused, and reports when there is none", () => {
		document.body.innerHTML = `<aside data-work-board-panel><button data-board-waiting="q" id="only">Q</button></aside>`;
		expect(focusWorkBoard()).toBe(true);
		expect(focused?.id).toBe("only");
		document.body.innerHTML = "<main></main>";
		focused = null;
		expect(focusWorkBoard()).toBe(false);
		expect(focused).toBeNull();
	});
});
