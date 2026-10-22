// The renderer tests' DOM is linkedom, which has no `document.compatMode`. KaTeX reads it when it loads and, on a
// document that is not in standards mode, warns about quirks mode (once per test file that renders Markdown) and
// replaces its DOM renderer with one that throws. The app's pages are standards mode (index.html and web.html carry a
// doctype); linkedom's documents read the same here.
import { parseHTML } from "linkedom";
import { beforeAll } from "vitest";

const documentProto = Object.getPrototypeOf(parseHTML("<!doctype html><html></html>").document) as object;
if (!("compatMode" in documentProto)) {
	Object.defineProperty(documentProto, "compatMode", { configurable: true, get: () => "CSS1Compat" });
}

// linkedom's window has no viewport size, so a popover or tooltip that clamps itself to the window computed NaN and
// React warned about a `left: NaN` style in every file that renders one. A test file installs its own window at its
// top level, which runs before this hook; one that sets a size itself keeps it.
beforeAll(() => {
	const win = (globalThis as { window?: Record<string, unknown> }).window;
	if (!win) return;
	for (const [key, value] of [
		["innerWidth", 1280],
		["innerHeight", 800],
	] as const) {
		if (win[key] === undefined && Object.getOwnPropertyDescriptor(win, key)?.set === undefined) {
			Object.defineProperty(win, key, { configurable: true, writable: true, value });
		}
	}
});
