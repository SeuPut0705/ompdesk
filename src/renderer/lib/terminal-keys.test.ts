/** The phone's Terminal key bar: byte sequences, sticky modifiers and the font scale. */
import { describe, expect, it } from "vitest";
import {
	applyModifiers,
	clampFontScale,
	controlCharacter,
	FONT_SCALE_MAX,
	FONT_SCALE_MIN,
	fontSizeFor,
	isSingleKey,
	TERMINAL_KEYS,
} from "./terminal-keys";

const NONE = { ctrl: false, alt: false };

describe("TERMINAL_KEYS", () => {
	it("has the keys a soft keyboard lacks, with unique ids and the bytes a PTY expects", () => {
		const byId = new Map(TERMINAL_KEYS.map(key => [key.id, key]));
		expect(byId.size).toBe(TERMINAL_KEYS.length);
		expect(byId.get("esc")?.data).toBe("\x1b");
		expect(byId.get("tab")?.data).toBe("\t");
		expect(byId.get("shift-tab")?.data).toBe("\x1b[Z");
		expect(byId.get("up")?.data).toBe("\x1b[A");
		expect(byId.get("down")?.data).toBe("\x1b[B");
		expect(byId.get("right")?.data).toBe("\x1b[C");
		expect(byId.get("left")?.data).toBe("\x1b[D");
		expect(byId.get("ctrl-c")?.data).toBe("\x03");
		expect(byId.get("ctrl")?.modifier).toBe("ctrl");
		expect(byId.get("alt")?.modifier).toBe("alt");
		for (const symbol of [
			"|",
			"~",
			"/",
			"\\",
			"-",
			"_",
			"$",
			"&",
			"*",
			"^",
			"<",
			">",
			"{",
			"}",
			"[",
			"]",
			"(",
			")",
			":",
			";",
			'"',
			"'",
		]) {
			expect(
				TERMINAL_KEYS.some(key => key.data === symbol),
				symbol,
			).toBe(true);
		}
		expect(TERMINAL_KEYS.filter(key => key.repeat).map(key => key.id)).toEqual(["left", "down", "up", "right"]);
	});
});

describe("applyModifiers", () => {
	it("leaves data alone with nothing held", () => {
		expect(applyModifiers("a", NONE)).toBe("a");
		expect(applyModifiers("\x1b[A", NONE)).toBe("\x1b[A");
	});

	it("turns a letter into its control character with Ctrl", () => {
		expect(applyModifiers("c", { ctrl: true, alt: false })).toBe("\x03");
		expect(applyModifiers("D", { ctrl: true, alt: false })).toBe("\x04");
		expect(applyModifiers("[", { ctrl: true, alt: false })).toBe("\x1b");
		expect(applyModifiers("\\", { ctrl: true, alt: false })).toBe("\x1c");
		expect(applyModifiers(" ", { ctrl: true, alt: false })).toBe("\x00");
		expect(applyModifiers("1", { ctrl: true, alt: false })).toBe("1");
	});

	it("prefixes Esc for Alt, and combines both", () => {
		expect(applyModifiers("f", { ctrl: false, alt: true })).toBe("\x1bf");
		expect(applyModifiers("b", { ctrl: true, alt: true })).toBe("\x1b\x02");
	});

	it("puts the modifier in an arrow's escape sequence", () => {
		expect(applyModifiers("\x1b[A", { ctrl: true, alt: false })).toBe("\x1b[1;5A");
		expect(applyModifiers("\x1b[D", { ctrl: false, alt: true })).toBe("\x1b[1;3D");
		expect(applyModifiers("\x1b[C", { ctrl: true, alt: true })).toBe("\x1b[1;7C");
		expect(applyModifiers("\x1b[H", { ctrl: true, alt: false })).toBe("\x1b[1;5H");
	});

	it("never modifies a paste or other multi-character data", () => {
		expect(applyModifiers("hello world", { ctrl: true, alt: true })).toBe("hello world");
		expect(applyModifiers("\x1b[5~", { ctrl: true, alt: false })).toBe("\x1b[5~");
	});
});

describe("controlCharacter / isSingleKey", () => {
	it("knows the control characters and which data is one key", () => {
		expect(controlCharacter("a")).toBe("\x01");
		expect(controlCharacter("?")).toBe("\x7f");
		expect(controlCharacter("é")).toBeNull();
		expect(controlCharacter("ab")).toBeNull();
		expect(isSingleKey("x")).toBe(true);
		expect(isSingleKey("\x1b[A")).toBe(true);
		expect(isSingleKey("\x1b[5~")).toBe(true);
		expect(isSingleKey("ls -la")).toBe(false);
	});
});

describe("font scale", () => {
	it("is held to 50–200 % in steps of 10 and sizes the font from a 12 px base", () => {
		expect(clampFontScale(10)).toBe(FONT_SCALE_MIN);
		expect(clampFontScale(999)).toBe(FONT_SCALE_MAX);
		expect(clampFontScale(113)).toBe(110);
		expect(clampFontScale(Number.NaN)).toBe(100);
		expect(fontSizeFor(100)).toBe(12);
		expect(fontSizeFor(50)).toBe(6);
		expect(fontSizeFor(200)).toBe(24);
		expect(fontSizeFor(150)).toBe(18);
	});
});
