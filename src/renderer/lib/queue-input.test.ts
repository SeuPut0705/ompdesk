/**
 * Contract tests for the queue shorthand parser, ported from the TUI
 * (`packages/coding-agent/src/modes/queue-input.ts`). These pin the
 * regression-prone parsing boundary: prefix extraction, enumerated-list
 * validation (indent/punctuation/sequence), and split output shape.
 */
import { describe, expect, it } from "vitest";
import { isQueuedMessageList, parseQueueShorthand, splitQueuedMessages } from "./queue-input";

describe("parseQueueShorthand", () => {
	it("extracts the body from both prefixes and trims", () => {
		expect(parseQueueShorthand("-> hello")).toBe("hello");
		expect(parseQueueShorthand("=> hello")).toBe("hello");
		expect(parseQueueShorthand("->   spaced   ")).toBe("spaced");
	});

	it("returns an empty string for a bare prefix", () => {
		expect(parseQueueShorthand("->")).toBe("");
		expect(parseQueueShorthand("=>")).toBe("");
	});

	it("returns undefined for non-queue text", () => {
		expect(parseQueueShorthand("hello")).toBeUndefined();
		expect(parseQueueShorthand("- not a prefix")).toBeUndefined();
		expect(parseQueueShorthand("->>")).toBe(">"); // prefix matches, body is ">"
	});
});

describe("isQueuedMessageList / splitQueuedMessages", () => {
	it("splits a sequential decimal list", () => {
		const text = "1. first\n2. second\n3. third";
		expect(isQueuedMessageList(text)).toBe(true);
		expect(splitQueuedMessages(text)).toEqual(["first", "second", "third"]);
	});

	it("accepts ) punctuation uniformly", () => {
		const text = "1) first\n2) second";
		expect(splitQueuedMessages(text)).toEqual(["first", "second"]);
	});

	it("rejects mixed punctuation", () => {
		const text = "1. first\n2) second";
		expect(isQueuedMessageList(text)).toBe(false);
		expect(splitQueuedMessages(text)).toEqual(["1. first\n2) second"]);
	});

	it("rejects non-sequential numbering", () => {
		const text = "1. first\n3. third";
		expect(isQueuedMessageList(text)).toBe(false);
	});

	it("rejects a single item", () => {
		expect(isQueuedMessageList("1. only")).toBe(false);
		expect(splitQueuedMessages("1. only")).toEqual(["1. only"]);
	});

	it("splits canonical Roman numerals, case-consistent", () => {
		expect(splitQueuedMessages("i. one\nii. two\niii. three")).toEqual(["one", "two", "three"]);
		expect(splitQueuedMessages("I. one\nII. two")).toEqual(["one", "two"]);
	});

	it("rejects mixed-case Roman/alpha sequences", () => {
		expect(isQueuedMessageList("i. one\nII. two")).toBe(false);
	});

	it("rejects non-canonical Roman numerals", () => {
		expect(isQueuedMessageList("iiii. four\nv. five")).toBe(false);
	});

	it("splits alphabetic sequences", () => {
		expect(splitQueuedMessages("a. first\nb. second\nc. third")).toEqual(["first", "second", "third"]);
	});

	it("attaches indented continuation lines to the previous item", () => {
		const text = "1. first\n   more detail\n2. second";
		expect(splitQueuedMessages(text)).toEqual(["first\n   more detail", "second"]);
	});

	it("attaches deeper-indented sub-lists to the previous item", () => {
		const text = "1. first\n  a. nested\n  b. nested\n2. second";
		expect(splitQueuedMessages(text)).toEqual(["first\n  a. nested\n  b. nested", "second"]);
	});

	it("rejects when a sibling item changes indent", () => {
		const text = "1. first\n  2. second";
		expect(isQueuedMessageList(text)).toBe(false);
	});

	it("treats non-list text as a single entry", () => {
		expect(splitQueuedMessages("just a message")).toEqual(["just a message"]);
		expect(splitQueuedMessages("  padded  ")).toEqual(["padded"]);
	});

	it("returns no entries for empty text", () => {
		expect(splitQueuedMessages("")).toEqual([]);
		expect(splitQueuedMessages("   ")).toEqual([]);
	});

	it("drops empty trailing items and falls back when any item is empty", () => {
		expect(splitQueuedMessages("1. first\n2.")).toEqual(["first"]);
		// An empty item in the middle makes every() fail → original source kept as one entry.
		expect(splitQueuedMessages("1.\n2. second")).toEqual(["1.\n2. second"]);
	});
});
