import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import { measurePromptRoom } from "./ask-dock";

// A session pane as SplitWorkspace lays it out at 1000x800. linkedom has no layout: `data-h` is each element's
// height, `data-grow` and `data-pos` its flex and position.
function pane({ strip, dock, card }: { strip: boolean; dock: boolean; card: boolean }): string {
	return `<section class="omp-session-pane" data-h="752">
		<header data-h="36"></header>
		<div data-grow="1">
			<div class="omp-transcript-editorial" data-grow="1"></div>
			<div class="omp-work-board-slot" data-pos="absolute" data-h="752"></div>
			${strip ? '<div class="omp-work-strip" data-h="40"></div>' : ""}
			<div class="omp-composer-region" data-h="${dock ? 214 : 8}">
				<div data-workspace-dock data-h="${dock ? 206 : 0}">
					${dock ? '<div data-h="40"></div><div data-testid="workspace-dock" data-h="148"></div>' : ""}
				</div>
			</div>
		</div>
		<div class="omp-composer-region" data-h="${card ? 562 : 112}">
			<div class="omp-ask-dock" data-h="${card ? 450 : 0}">${card ? "<section data-prompt-card></section>" : ""}</div>
			<div class="omp-composer-box" data-h="92"></div>
		</div>
	</section>`;
}

const saved = {
	HTMLElement: globalThis.HTMLElement,
	getComputedStyle: globalThis.getComputedStyle,
};

function mount(layout: { strip: boolean; dock: boolean; card: boolean }): HTMLElement {
	const { document, window } = parseHTML(`<!doctype html><html><body>${pane(layout)}</body></html>`);
	const height = (element: Element) => Number(element.getAttribute("data-h") ?? 0);
	Object.assign(globalThis, {
		HTMLElement: window.HTMLElement,
		getComputedStyle: (element: Element) => ({
			flexGrow: element.getAttribute("data-grow") ?? "0",
			position: element.getAttribute("data-pos") ?? "static",
		}),
	});
	window.HTMLElement.prototype.getBoundingClientRect = function (this: Element) {
		return { top: 0, bottom: height(this), left: 0, right: 0, width: 0, height: height(this), x: 0, y: 0 } as DOMRect;
	};
	const paneElement = document.querySelector(".omp-session-pane") as unknown as HTMLElement;
	Object.defineProperty(paneElement, "clientHeight", { value: height(paneElement as unknown as Element) });
	return document.querySelector(".omp-ask-dock") as unknown as HTMLElement;
}

afterEach(() => {
	Object.assign(globalThis, saved);
});

describe("measurePromptRoom: the 240 px transcript floor", () => {
	it("keeps the floor under a card with nothing else above the composer", () => {
		// 752 pane − 36 header − 8 empty dock region − 112 composer region without the card − 240 floor.
		expect(measurePromptRoom(mount({ strip: false, dock: false, card: true }))).toEqual({ card: 356, dock: 0 });
	});

	it("takes the work strip off the room", () => {
		expect(measurePromptRoom(mount({ strip: true, dock: false, card: true }))).toEqual({ card: 316, dock: 0 });
	});

	it("takes the dock's own rows off the room and leaves its cards what the card does not use", () => {
		// The dock region is 214 px, 148 of them its scrolling cards: the other 66 stay, the cards yield.
		const room = measurePromptRoom(mount({ strip: false, dock: true, card: true }));
		expect(room).toEqual({ card: 298, dock: 0 });
	});

	it("takes both the strip and the dock's rows off the room", () => {
		expect(measurePromptRoom(mount({ strip: true, dock: true, card: true }))).toEqual({ card: 258, dock: 0 });
	});

	it("gives the dock's cards the room a short card leaves", () => {
		const askDock = mount({ strip: true, dock: true, card: true });
		askDock.setAttribute("data-h", "185");
		askDock.closest(".omp-composer-region")?.setAttribute("data-h", "297");
		// 258 for the card and the dock's cards together; the card takes 185.
		expect(measurePromptRoom(askDock)).toEqual({ card: 258, dock: 73 });
	});

	it("leaves the dock uncapped while no card waits", () => {
		expect(measurePromptRoom(mount({ strip: true, dock: true, card: false }))?.dock).toBeNull();
	});
});
