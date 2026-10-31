import { describe, expect, it } from "vitest";
import { installFocusModality } from "./focus-modality";

/** An element as the module reads it: its name, an input's normalized `type`, `isContentEditable`. */
function element(localName: string, extra: Record<string, unknown> = {}) {
	return { localName, isContentEditable: false, ...extra };
}

function fakeView() {
	const root = { dataset: {} as DOMStringMap };
	const doc = { documentElement: root, activeElement: element("body") as unknown };
	const view = Object.assign(new EventTarget(), { document: doc });
	// The module reads only `documentElement.dataset`, `activeElement` and the window's events.
	const focus = (target: unknown) => {
		doc.activeElement = target;
		view.dispatchEvent(new Event("focusin"));
	};
	return { view: view as unknown as Window, root, focus };
}

const key = (value: string) => Object.assign(new Event("keydown"), { key: value });

describe("installFocusModality", () => {
	it("marks a pointer press and keeps it through modifiers pressed alone", () => {
		const { view, root } = fakeView();
		const uninstall = installFocusModality(view);
		expect(root.dataset.focusModality).toBeUndefined();
		view.dispatchEvent(new Event("pointerdown"));
		expect(root.dataset.focusModality).toBe("pointer");
		for (const modifier of ["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]) {
			view.dispatchEvent(key(modifier));
			expect(root.dataset.focusModality, modifier).toBe("pointer");
		}
		uninstall();
		expect(root.dataset.focusModality).toBeUndefined();
	});

	it("clears the mark on any other key, so Tab, arrows and shortcuts defer to the browser", () => {
		const { view, root } = fakeView();
		const uninstall = installFocusModality(view);
		for (const other of ["Tab", "ArrowDown", "Escape", "a", "Enter"]) {
			view.dispatchEvent(new Event("pointerdown"));
			view.dispatchEvent(key(other));
			expect(root.dataset.focusModality, other).toBeUndefined();
		}
		uninstall();
		view.dispatchEvent(new Event("pointerdown"));
		expect(root.dataset.focusModality).toBeUndefined();
	});

	it("leaves a text field its focus style: the mark is off while one holds the focus", () => {
		const { view, root, focus } = fakeView();
		const uninstall = installFocusModality(view);
		view.dispatchEvent(new Event("pointerdown"));
		for (const field of [
			element("textarea"),
			element("input", { type: "text" }),
			element("input", { type: "search" }),
			element("div", { isContentEditable: true }),
		]) {
			focus(field);
			expect(root.dataset.focusModality, field.localName).toBeUndefined();
			// A click away from it onto a button marks the pointer again.
			focus(element("button"));
			expect(root.dataset.focusModality).toBe("pointer");
		}
		for (const control of [element("input", { type: "checkbox" }), element("select"), element("div")]) {
			focus(control);
			expect(root.dataset.focusModality, control.localName).toBe("pointer");
		}
		uninstall();
	});
});
