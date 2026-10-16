/** The hidden input's events as what the streamed page receives: keys, committed text, no half-formed IME. */
import { describe, expect, it } from "vitest";
import { beforeInputInputs, compositionInputs, type KeyDownLike, keyInputs } from "./preview-keyboard";

const key = (partial: Partial<KeyDownLike> & { key: string }): KeyDownLike => ({
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	shiftKey: false,
	isComposing: false,
	...partial,
});

describe("keyInputs", () => {
	it("forwards a special key, with the modifiers held", () => {
		expect(keyInputs(key({ key: "Enter" }))).toEqual([{ t: "key", key: "Enter" }]);
		expect(keyInputs(key({ key: "Tab", shiftKey: true }))).toEqual([{ t: "key", key: "Tab", mods: ["shift"] }]);
		expect(keyInputs(key({ key: "ArrowLeft", ctrlKey: true, altKey: true }))).toEqual([
			{ t: "key", key: "ArrowLeft", mods: ["control", "alt"] },
		]);
	});

	it("forwards a shortcut as a key press, never as text", () => {
		expect(keyInputs(key({ key: "a", ctrlKey: true }))).toEqual([{ t: "key", key: "a", mods: ["control"] }]);
		expect(keyInputs(key({ key: "C", metaKey: true, shiftKey: true }))).toEqual([
			{ t: "key", key: "c", mods: ["shift", "meta"] },
		]);
	});

	it("leaves printable keys to beforeinput, and a paste shortcut to the paste", () => {
		expect(keyInputs(key({ key: "a" }))).toBeNull();
		expect(keyInputs(key({ key: "A", shiftKey: true }))).toBeNull();
		expect(keyInputs(key({ key: "v", ctrlKey: true }))).toBeNull();
		expect(keyInputs(key({ key: "V", metaKey: true }))).toBeNull();
	});

	it("ignores keys that mean nothing alone and every key of a composition", () => {
		for (const silent of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Unidentified", "Process"]) {
			expect(keyInputs(key({ key: silent }))).toBeNull();
		}
		expect(keyInputs(key({ key: "ㅎ", isComposing: true }))).toBeNull();
		expect(keyInputs(key({ key: "Backspace", keyCode: 229 }))).toBeNull();
	});
});

describe("beforeInputInputs", () => {
	const input = (inputType: string, data: string | null = null, extra: object = {}) =>
		beforeInputInputs({ inputType, data, isComposing: false, ...extra });

	it("sends typed, pasted and replacement text whole and keeps the field empty", () => {
		expect(input("insertText", "a")).toEqual({ inputs: [{ t: "text", text: "a" }], prevent: true });
		expect(input("insertFromPaste", null, { pasted: "pasted text" })).toEqual({
			inputs: [{ t: "text", text: "pasted text" }],
			prevent: true,
		});
		expect(input("insertReplacementText", "fixed").inputs).toEqual([{ t: "text", text: "fixed" }]);
	});

	it("turns a soft keyboard's line break and deletions into the keys they mean", () => {
		expect(input("insertLineBreak").inputs).toEqual([{ t: "key", key: "Enter" }]);
		expect(input("insertParagraph").inputs).toEqual([{ t: "key", key: "Enter" }]);
		expect(input("deleteContentBackward").inputs).toEqual([{ t: "key", key: "Backspace" }]);
		expect(input("deleteContentForward").inputs).toEqual([{ t: "key", key: "Delete" }]);
	});

	it("sends nothing while an IME composes, and does not prevent it", () => {
		expect(input("insertCompositionText", "하")).toEqual({ inputs: [], prevent: false });
		expect(beforeInputInputs({ inputType: "insertText", data: "한", isComposing: true })).toEqual({
			inputs: [],
			prevent: false,
		});
	});

	it("drops an input type it has no meaning for, and sends no empty text", () => {
		expect(input("formatBold")).toEqual({ inputs: [], prevent: true });
		expect(input("insertText", null).inputs).toEqual([]);
	});
});

describe("compositionInputs", () => {
	it("sends the committed composition once, and nothing for an empty one", () => {
		expect(compositionInputs("한글")).toEqual([{ t: "text", text: "한글" }]);
		expect(compositionInputs("")).toEqual([]);
	});
});
