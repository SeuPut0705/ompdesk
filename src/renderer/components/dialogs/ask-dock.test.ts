import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import { measurePromptRoom } from "./ask-dock";

interface Layout {
	pane?: number;
	strip?: boolean;
	dock?: boolean;
	card?: number;
	widget?: number;
	banner?: number;
}

// A session pane as SplitWorkspace lays it out at 1000x800. linkedom has no layout: `data-h` is each element's
// height, `data-grow`, `data-pos` and `data-mt`/`data-mb` its flex, position and margins. The ask dock holds its
// children's margins (flow-root), so its height counts the card's and the widgets' 8 px.
function pane({ pane = 752, strip = false, dock = false, card = 0, widget = 0, banner = 0 }: Layout): string {
	const ask = (card ? card + 8 : 0) + (widget ? widget + 8 : 0);
	return `<section class="omp-session-pane" data-h="${pane}">
		<header data-h="36"></header>
		${banner ? `<div data-h="${banner}" data-mt="8"></div>` : ""}
		<div data-grow="1">
			<div class="omp-transcript-editorial" data-grow="1"></div>
			<div class="omp-work-board-slot" data-pos="absolute" data-h="${pane}"></div>
			${strip ? '<div class="omp-work-strip" data-h="40"></div>' : ""}
			<div class="omp-composer-region" data-h="${dock ? 214 : 8}">
				<div data-workspace-dock data-h="${dock ? 206 : 0}">
					${dock ? '<div data-h="40"></div><div data-testid="workspace-dock" data-h="148"></div>' : ""}
				</div>
			</div>
		</div>
		<div class="omp-composer-region" data-h="${112 + ask}">
			<div class="omp-ask-dock" data-h="${ask}">
				${widget ? `<div data-h="${widget}" data-mb="8"></div>` : ""}
				${card ? `<section data-prompt-card data-h="${card}" data-mb="8"></section>` : ""}
			</div>
			<div class="omp-composer-box" data-h="92"></div>
		</div>
	</section>`;
}

const saved = {
	HTMLElement: globalThis.HTMLElement,
	getComputedStyle: globalThis.getComputedStyle,
};

function room(layout: Layout) {
	const { document, window } = parseHTML(`<!doctype html><html><body>${pane(layout)}</body></html>`);
	const height = (element: Element) => Number(element.getAttribute("data-h") ?? 0);
	Object.assign(globalThis, {
		HTMLElement: window.HTMLElement,
		getComputedStyle: (element: Element) => ({
			flexGrow: element.getAttribute("data-grow") ?? "0",
			position: element.getAttribute("data-pos") ?? "static",
			marginTop: `${element.getAttribute("data-mt") ?? 0}px`,
			marginBottom: `${element.getAttribute("data-mb") ?? 0}px`,
		}),
	});
	window.HTMLElement.prototype.getBoundingClientRect = function (this: Element) {
		return { top: 0, bottom: height(this), left: 0, right: 0, width: 0, height: height(this), x: 0, y: 0 } as DOMRect;
	};
	const paneElement = document.querySelector(".omp-session-pane") as unknown as HTMLElement;
	Object.defineProperty(paneElement, "clientHeight", { value: height(paneElement as unknown as Element) });
	return measurePromptRoom(document.querySelector(".omp-ask-dock") as unknown as HTMLElement);
}

afterEach(() => {
	Object.assign(globalThis, saved);
});

describe("measurePromptRoom: the 240 px transcript floor", () => {
	it("keeps the floor under an 8-option card with nothing else above the composer", () => {
		// 752 pane − 36 header − 8 empty dock region − 92 composer box − 20 below it − 8 card margin − 240 floor.
		expect(room({ card: 440 })).toEqual({ card: 348, dock: 0 });
	});

	it("takes the work strip off the room", () => {
		expect(room({ strip: true, card: 440 })).toEqual({ card: 308, dock: 0 });
	});

	it("takes the dock's own rows off the room and leaves its cards nothing beside a tall card", () => {
		// The dock region is 214 px, 148 of them its scrolling cards: the other 66 stay.
		expect(room({ dock: true, card: 440 })).toEqual({ card: 290, dock: 0 });
	});

	it("takes both the strip and the dock's rows off the room", () => {
		expect(room({ strip: true, dock: true, card: 440 })).toEqual({ card: 250, dock: 0 });
	});

	it("gives the dock's cards the room a short card leaves above the floor", () => {
		// 250 for the card and the dock's cards together; the card takes 185.
		expect(room({ strip: true, dock: true, card: 185 })).toEqual({ card: 250, dock: 65 });
	});

	it("takes an extension widget over the card off the room, with its margin", () => {
		expect(room({ card: 440, widget: 60 })).toEqual({ card: 280, dock: 0 });
	});

	it("takes a banner off the room, with its margin", () => {
		expect(room({ card: 440, banner: 40 })).toEqual({ card: 300, dock: 0 });
	});

	it("leaves the dock uncapped while no card waits", () => {
		expect(room({ strip: true, dock: true })?.dock).toBeNull();
	});

	it("lets a short split pane keep a 2-option card whole, as before the floor", () => {
		// The top pane of a 1000x800 window split in two: 373 px under its 36 px header. Before the floor the card had
		// 373 − 36 − 112 composer region − 8 margin − 32 = 185 px; it keeps 217, the transcript gives way.
		const short = room({ pane: 373, strip: true, dock: true, card: 178 });
		expect(short?.card).toBeGreaterThanOrEqual(185);
		expect(short).toEqual({ card: 217, dock: 0 });
	});

	it("never lets the floor squeeze a card under 240 px while the pane holds it", () => {
		// 520 px pane: 258 px of room, 18 above the floor; the card keeps 240 and the transcript gets the other 18.
		expect(room({ pane: 520, strip: true, dock: true, card: 440 })).toEqual({ card: 240, dock: 0 });
	});
});
