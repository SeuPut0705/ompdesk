import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPaneKeys } from "./pane-keys";

const { document, HTMLElement, Event } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.HTMLElement = HTMLElement;

let cleanup: () => void = () => {};
afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
});

function setup(composerScroll = { top: 0, client: 40, height: 40 }) {
	document.body.innerHTML = `<div class="omp-session-pane">
		<div class="transcript" tabindex="0"><button id="tool">Expand</button><input id="field"></div>
		<div class="omp-composer-anchor"><textarea class="omp-composer-input"></textarea></div>
		<div role="dialog"><button id="dialog-button">OK</button></div>
		<section data-prompt-card role="region"><button id="choice" data-choice="b">Lint</button></section>
	</div>`;
	const pane = document.querySelector(".omp-session-pane") as unknown as HTMLElement;
	const composer = document.querySelector("textarea") as unknown as HTMLTextAreaElement & { focused?: boolean };
	Object.defineProperty(composer, "scrollTop", { value: composerScroll.top });
	Object.defineProperty(composer, "clientHeight", { value: composerScroll.client });
	Object.defineProperty(composer, "scrollHeight", { value: composerScroll.height });
	composer.focus = () => {
		composer.focused = true;
	};
	const page = vi.fn((_direction: "up" | "down", event: KeyboardEvent) => event.preventDefault());
	cleanup = installPaneKeys(pane, page);
	return { composer, page };
}

function press(selector: string, init: Record<string, unknown>): { defaultPrevented: boolean } {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { ctrlKey: false, metaKey: false, altKey: false, ...init });
	document.querySelector(selector)?.dispatchEvent(event);
	return { defaultPrevented: event.defaultPrevented };
}

describe("installPaneKeys", () => {
	it("moves a printable key typed on transcript chrome into the composer", () => {
		const { composer } = setup();
		press("#tool", { key: "a" });
		expect(composer.focused).toBe(true);
	});

	it("starts an IME composition in the composer", () => {
		const { composer } = setup();
		press(".transcript", { key: "Process" });
		expect(composer.focused).toBe(true);
	});

	it("leaves shortcuts, Space, fields, dialogs and prompt cards alone", () => {
		const { composer } = setup();
		press("#tool", { key: "c", metaKey: true });
		press("#tool", { key: " " });
		press("#field", { key: "a" });
		press("#dialog-button", { key: "a" });
		// A prompt card's digits pick its rows; a second digit must not land in the draft.
		press("#choice", { key: "3" });
		press("#tool", { key: "ArrowDown" });
		expect(composer.focused).toBeUndefined();
	});

	it("pages the transcript from the composer unless a completion list is open", () => {
		const { page } = setup();
		expect(press("textarea", { key: "PageUp" }).defaultPrevented).toBe(true);
		press("textarea", { key: "PageDown" });
		expect(page.mock.calls.map(call => call[0])).toEqual(["up", "down"]);
		const list = document.createElement("div");
		list.setAttribute("role", "listbox");
		document.querySelector(".omp-composer-anchor")?.appendChild(list);
		press("textarea", { key: "PageDown" });
		expect(page).toHaveBeenCalledTimes(2);
	});

	it("lets a long draft page itself first", () => {
		const { page } = setup({ top: 20, client: 40, height: 200 });
		press("textarea", { key: "PageUp" });
		press("textarea", { key: "PageDown" });
		expect(page).not.toHaveBeenCalled();
	});
});
