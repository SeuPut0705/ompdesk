import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import { isTopmostDialog, registerDialogLayer } from "./dialog-layer";

const parsed = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	document: parsed.document,
	HTMLElement: parsed.HTMLElement,
});

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	parsed.document.body.replaceChildren();
});

describe("dialog interaction layers", () => {
	it("uses open order instead of DOM order for nested overlays", () => {
		const palette = parsed.document.createElement("div");
		palette.setAttribute("role", "dialog");
		const settings = parsed.document.createElement("div");
		settings.setAttribute("role", "dialog");

		// Settings is later in DOM because it is portalled, but the palette is
		// opened afterward and must be the only layer allowed to consume Escape.
		parsed.document.body.append(palette, settings);
		cleanups.push(registerDialogLayer(settings));
		const closePalette = registerDialogLayer(palette);
		cleanups.push(closePalette);

		expect(isTopmostDialog(palette)).toBe(true);
		expect(isTopmostDialog(settings)).toBe(false);

		closePalette();
		expect(isTopmostDialog(settings)).toBe(true);
	});
});
