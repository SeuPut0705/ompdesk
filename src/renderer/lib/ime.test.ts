import { describe, expect, it } from "vitest";
import { isImeKeyEvent, noteCompositionEnd, POST_COMPOSITION_MS } from "./ime";

/**
 * Contract: while an IME owns the keystroke, no picker, composer, or dialog may
 * act on it. If this regresses, a Chinese/Japanese user committing a candidate
 * with Enter sends the composer message, switches the model, or closes the
 * dialog they were still typing in.
 */
function reactEvent(init: { key?: string; isComposing?: boolean; keyCode?: number }) {
	return {
		key: init.key ?? "Process",
		// React does not proxy `isComposing`; every renderer handler reads the
		// native flag through `nativeEvent`.
		nativeEvent: { isComposing: init.isComposing ?? false },
		keyCode: init.keyCode ?? 229,
	};
}

describe("isImeKeyEvent", () => {
	it("claims every key a React handler receives mid-composition, including Enter", () => {
		expect(isImeKeyEvent(reactEvent({ key: "Enter", isComposing: true }))).toBe(true);
		expect(isImeKeyEvent(reactEvent({ key: "ArrowDown", isComposing: true }))).toBe(true);
	});

	it("releases the key once the composition is closed", () => {
		expect(isImeKeyEvent(reactEvent({ key: "Enter", keyCode: 13 }))).toBe(false);
	});

	it("reads the flag directly on a document-level native event", () => {
		expect(isImeKeyEvent({ key: "Enter", isComposing: true, keyCode: 229 })).toBe(true);
		expect(isImeKeyEvent({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(false);
	});

	it("keeps Escape alive on the legacy 229 path but hands it to the IME while composing", () => {
		// Chromium keeps reporting keyCode 229 after composition ends; swallowing
		// Escape there traps the user in the overlay.
		expect(isImeKeyEvent(reactEvent({ key: "Escape" }))).toBe(false);
		expect(isImeKeyEvent(reactEvent({ key: "Escape", isComposing: true }))).toBe(true);
	});
});

describe("Safari's order: compositionend before the committing Enter", () => {
	const enterAt = (timeStamp: number) => ({
		key: "Enter",
		keyCode: 13,
		nativeEvent: { isComposing: false, timeStamp },
	});

	it("ignores the Enter that follows a compositionend within a moment, once, and no later Enter", () => {
		noteCompositionEnd({ timeStamp: 1000 });
		expect(isImeKeyEvent(enterAt(1000 + POST_COMPOSITION_MS - 1))).toBe(true);
		expect(isImeKeyEvent(enterAt(1000 + POST_COMPOSITION_MS + 1))).toBe(false);
		// An Enter before the composition ended (Chromium's order) is the isComposing path, not this one.
		expect(isImeKeyEvent(enterAt(990))).toBe(false);
	});

	it("never takes another key, and does nothing for an event without a clock", () => {
		noteCompositionEnd({ timeStamp: 2000 });
		expect(isImeKeyEvent({ key: "a", keyCode: 65, nativeEvent: { isComposing: false, timeStamp: 2001 } })).toBe(
			false,
		);
		expect(isImeKeyEvent({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } })).toBe(false);
	});
});
