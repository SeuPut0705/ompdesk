import { beforeEach, describe, expect, it } from "vitest";
import {
	composerEnterNewline,
	type HardwareKeyEvent,
	hasHardwareKeyboard,
	isHardwareKey,
	noteHardwareKey,
	resetHardwareKeyboardForTests,
} from "./hardware-keyboard";

const key = (name: string, init: Partial<HardwareKeyEvent> = {}): HardwareKeyEvent => ({
	key: name,
	shiftKey: false,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	...init,
});

beforeEach(resetHardwareKeyboardForTests);

describe("hardware keyboard detection", () => {
	it("a soft keyboard's keys are no evidence", () => {
		for (const name of ["a", "A", "한", " ", "Backspace", "Enter", "Unidentified", "Process", "Shift"])
			expect(isHardwareKey(key(name))).toBe(false);
	});

	it("navigation, function keys, chords and Shift+Enter are", () => {
		for (const name of ["Escape", "Tab", "ArrowUp", "ArrowLeft", "Home", "PageDown", "Delete", "F5"])
			expect(isHardwareKey(key(name))).toBe(true);
		expect(isHardwareKey(key("c", { metaKey: true }))).toBe(true);
		expect(isHardwareKey(key("Enter", { shiftKey: true }))).toBe(true);
		expect(isHardwareKey(key("Enter", { ctrlKey: true }))).toBe(true);
		expect(isHardwareKey(key("Control", { ctrlKey: true }))).toBe(false);
	});

	it("the first physical key latches for the page", () => {
		noteHardwareKey(key("a"));
		expect(hasHardwareKeyboard()).toBe(false);
		noteHardwareKey(key("ArrowDown"));
		expect(hasHardwareKeyboard()).toBe(true);
		noteHardwareKey(key("b"));
		expect(hasHardwareKeyboard()).toBe(true);
	});

	it("Enter is a newline on touch only until a keyboard shows up or the setting is on", () => {
		expect(composerEnterNewline(false, false)).toBe(false);
		expect(composerEnterNewline(true, false)).toBe(true);
		expect(composerEnterNewline(true, true)).toBe(false);
		noteHardwareKey(key("Tab"));
		expect(composerEnterNewline(true, false)).toBe(false);
	});
});
