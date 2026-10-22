import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cycleRegion, handleRegionKey } from "./region-cycle";

describe("F6 region cycling", () => {
	let focused: Element | null = null;
	let restore: () => void = () => {};

	beforeEach(() => {
		const { window } = parseHTML(`<!doctype html><html><body>
			<aside class="omp-session-sidebar"><input id="search"><button data-roving-item tabindex="0" id="row">Session</button></aside>
			<div class="omp-session-pane" data-active="true">
				<div class="omp-transcript-scroll" tabindex="0" id="transcript"></div>
				<div class="omp-composer-box"><button id="plus">+</button><textarea data-composer-input id="composer"></textarea></div>
				<aside data-work-board-panel id="board"><button id="fold">Plan</button></aside>
			</div>
			<aside class="omp-inspector" id="panel" hidden><button id="terminal">Terminal</button></aside>
		</body></html>`);
		const g = globalThis as Record<string, unknown>;
		const before = { document: g.document, HTMLElement: g.HTMLElement };
		g.document = window.document;
		g.HTMLElement = window.HTMLElement;
		focused = null;
		const proto = window.HTMLElement.prototype as HTMLElement;
		proto.focus = function (this: HTMLElement) {
			focused = this;
		};
		// linkedom draws nothing: an element is on screen unless it is under `hidden`.
		proto.getClientRects = function (this: HTMLElement) {
			return (this.closest("[hidden]") ? [] : [{}]) as unknown as DOMRectList;
		};
		Object.defineProperty(window.document, "activeElement", { configurable: true, get: () => focused });
		restore = () => Object.assign(g, before);
	});
	afterEach(() => restore());

	const id = () => (focused as Element | null)?.id;

	it("goes sidebar → transcript → composer → board and round, landing on each region's own control", () => {
		expect(cycleRegion(1)).toBe(true);
		expect(id()).toBe("row");
		cycleRegion(1);
		expect(id()).toBe("transcript");
		cycleRegion(1);
		expect(id()).toBe("composer");
		cycleRegion(1);
		expect(id()).toBe("fold");
		// The side panel is closed (hidden): it is passed over.
		cycleRegion(1);
		expect(id()).toBe("row");
	});

	it("Shift+F6 goes back, and a region opened later joins the round", () => {
		cycleRegion(1);
		cycleRegion(-1);
		expect(id()).toBe("fold");
		document.getElementById("panel")?.removeAttribute("hidden");
		cycleRegion(1);
		expect(id()).toBe("terminal");
	});

	it("moves nothing while a dialog holds the keyboard, and leaves modified F6 alone", () => {
		document.body.insertAdjacentHTML("beforeend", '<div role="dialog"><button>OK</button></div>');
		expect(cycleRegion(1)).toBe(false);
		expect(focused).toBeNull();
		document.querySelector('[role="dialog"]')?.remove();
		let prevented = false;
		const event = {
			key: "F6",
			ctrlKey: true,
			altKey: false,
			metaKey: false,
			shiftKey: false,
			defaultPrevented: false,
			preventDefault: () => {
				prevented = true;
			},
		};
		handleRegionKey(event as unknown as KeyboardEvent);
		expect(prevented).toBe(false);
		expect(focused).toBeNull();
		handleRegionKey({ ...event, ctrlKey: false } as unknown as KeyboardEvent);
		expect(prevented).toBe(true);
		expect(id()).toBe("row");
	});
});
