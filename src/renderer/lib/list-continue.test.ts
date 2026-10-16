import { describe, expect, it } from "vitest";
import { continueList, insideCodeFence, type ListEdit } from "./list-continue";

/** Apply an edit the way the composer does and return the text with `|` at the caret. */
function run(input: string): string | null {
	const caret = input.indexOf("|");
	const text = input.replace("|", "");
	const edit: ListEdit | null = continueList(text, caret);
	if (!edit) return null;
	const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
	return `${out.slice(0, edit.caret)}|${out.slice(edit.caret)}`;
}

describe("continueList", () => {
	it("continues bullets with the same marker and indent", () => {
		expect(run("- one|")).toBe("- one\n- |");
		expect(run("* one|")).toBe("* one\n* |");
		expect(run("+ one|")).toBe("+ one\n+ |");
		expect(run("  - nested|")).toBe("  - nested\n  - |");
		expect(run("\t- tabbed|")).toBe("\t- tabbed\n\t- |");
	});

	it("increments ordered numbers and keeps the delimiter", () => {
		expect(run("1. a|")).toBe("1. a\n2. |");
		expect(run("9) a|")).toBe("9) a\n10) |");
		expect(run("  3. a|")).toBe("  3. a\n  4. |");
	});

	it("resets task boxes", () => {
		expect(run("- [ ] todo|")).toBe("- [ ] todo\n- [ ] |");
		expect(run("- [x] done|")).toBe("- [x] done\n- [ ] |");
		expect(run("1. [X] done|")).toBe("1. [X] done\n2. [ ] |");
	});

	it("ends the list on an empty item", () => {
		expect(run("- a\n- |")).toBe("- a\n|");
		expect(run("  1. |")).toBe("|");
		expect(run("- [ ] |")).toBe("|");
		expect(run("- [ ]|")).toBe("|");
	});

	it("splits the line mid-item and gives the remainder the bullet", () => {
		expect(run("- ab|cd")).toBe("- ab\n- |cd");
		expect(run("1. ab|cd")).toBe("1. ab\n2. |cd");
	});

	it("leaves text that is not a list item alone", () => {
		expect(run("plain|")).toBeNull();
		expect(run("-dash|")).toBeNull();
		expect(run("-|")).toBeNull();
		expect(run("**bold**|")).toBeNull();
		expect(run("1.5 apples|")).toBeNull();
		expect(run("|")).toBeNull();
	});

	it("leaves a caret inside or before the bullet alone", () => {
		expect(run("|- a")).toBeNull();
		expect(run("-| a")).toBeNull();
		expect(run("  |- a")).toBeNull();
	});

	it("does nothing inside fenced code blocks", () => {
		expect(run("```\n- a|\n```")).toBeNull();
		expect(run("~~~md\n1. a|")).toBeNull();
		expect(run("```\ncode\n```\n- a|")).toBe("```\ncode\n```\n- a\n- |");
	});

	it("replaces a selection within the line", () => {
		const text = "- abcd";
		expect(continueList(text, 4, 5)).toEqual({ from: 4, to: 5, insert: "\n- ", caret: 7 });
		expect(continueList("- a\n- b", 3, 6)).toBeNull();
	});

	it("only looks at the caret's own line", () => {
		expect(run("- a\nplain|")).toBeNull();
		expect(run("- a|\nplain")).toBe("- a\n- |\nplain");
	});
});

describe("insideCodeFence", () => {
	it("tracks open and closed fences by character and length", () => {
		expect(insideCodeFence("```\nx", 4)).toBe(true);
		expect(insideCodeFence("```\nx\n```\ny", 10)).toBe(false);
		expect(insideCodeFence("````\n```\nx", 9)).toBe(true);
		expect(insideCodeFence("```\n~~~\nx", 8)).toBe(true);
	});
});
