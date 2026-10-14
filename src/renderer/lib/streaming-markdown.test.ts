import { describe, expect, it } from "vitest";
import { renderableTail, segmentStreamingMarkdown } from "./streaming-markdown";

describe("streaming Markdown segmentation", () => {
	it("promotes complete paragraphs while leaving the unfinished tail mutable", () => {
		const source = "First **complete** paragraph.\n\nSecond paragraph is still growing";
		const result = segmentStreamingMarkdown(source);

		expect(result.blocks).toEqual([{ end: 31, content: "First **complete** paragraph.\n\n" }]);
		expect(result.tailStart).toBe(31);
		expect(result.tail).toBe("Second paragraph is still growing");
	});

	it("does not split blank lines inside an unfinished fenced code block", () => {
		const source = "```ts\nconst first = 1;\n\nconst second = 2;";
		const result = segmentStreamingMarkdown(source);

		expect(result.blocks).toEqual([]);
		expect(result.tail).toBe(source);
	});

	it("promotes a fenced code block as soon as its closing line is complete", () => {
		const code = "```ts\nconst first = 1;\n\nconst second = 2;\n```\n";
		const result = segmentStreamingMarkdown(`${code}Next`);

		expect(result.blocks).toEqual([{ end: code.length, content: code }]);
		expect(result.tail).toBe("Next");
	});

	it("keeps display-math blank lines together until the closing fence", () => {
		const math = "$$\na + b\n\nc + d\n$$\n";
		const result = segmentStreamingMarkdown(`${math}Explanation`);

		expect(result.blocks).toEqual([{ end: math.length, content: math }]);
		expect(result.tail).toBe("Explanation");
	});
	it("keeps bracket math intact when delimiters share lines with the formula", () => {
		const unfinished = String.raw`\[a

\\]

+ b`;
		expect(segmentStreamingMarkdown(unfinished).blocks).toEqual([]);
		const completed = `${unfinished}\\]\n`;
		const result = segmentStreamingMarkdown(`${completed}Explanation`);
		expect(result.blocks).toEqual([{ end: completed.length, content: completed }]);
		expect(result.tail).toBe("Explanation");
	});

	it("keeps a completed list equation with its following indented explanation", () => {
		const source = "- Equation:\n\n  \\[\n  x = y\n  \\]\n\n  Explanation";
		const result = segmentStreamingMarkdown(source);
		expect(result.blocks).toEqual([]);
		expect(result.tail).toBe(source);
	});
	it("keeps indented list continuations in the same block across blank lines", () => {
		// Live: `second` belongs to the first <li>; promoting at the blank line
		// dropped it out of the list until message_end re-parsed everything.
		const source = "1. first\n\n   second paragraph";
		const result = segmentStreamingMarkdown(source);
		expect(result.blocks).toEqual([]);
		expect(result.tail).toBe(source);
	});

	it("ends the list block when a non-indented line follows a blank line", () => {
		const head = "1. first\n\n";
		const result = segmentStreamingMarkdown(`${head}Second paragraph`);
		expect(result.blocks).toEqual([{ end: head.length, content: head }]);
		expect(result.tailStart).toBe(head.length);
		expect(result.tail).toBe("Second paragraph");
	});

	it("keeps further list items in the same block after blank lines", () => {
		const source = "- alpha\n\n- beta still streaming";
		const result = segmentStreamingMarkdown(source);
		expect(result.blocks).toEqual([]);
		expect(result.tail).toBe(source);
	});

	it("reports an open display-math block, which the tail keeps as source", () => {
		expect(segmentStreamingMarkdown("Text\n\n$$\na + b\n").mathOpen).toBe(true);
		expect(segmentStreamingMarkdown("Text\n\n$$\na + b\n$$\n").mathOpen).toBe(false);
		expect(segmentStreamingMarkdown("```\n$$\n").mathOpen).toBe(false);
	});
});

describe("renderable streaming tail", () => {
	it("holds back a last line that is only a marker still being typed", () => {
		// A lone "-" under a paragraph would parse as a setext heading for a frame.
		expect(renderableTail("Some text\n-")).toBe("Some text\n");
		expect(renderableTail("Intro\n=")).toBe("Intro\n");
		expect(renderableTail("Intro\n##")).toBe("Intro\n");
		expect(renderableTail("Steps\n2.")).toBe("Steps\n");
		expect(renderableTail("Quote\n>")).toBe("Quote\n");
		expect(renderableTail("```")).toBe("");
	});

	it("keeps everything else, including a marker line that already has content", () => {
		expect(renderableTail("Some text\n- item")).toBe("Some text\n- item");
		expect(renderableTail("Plain words")).toBe("Plain words");
		expect(renderableTail("Price 2")).toBe("Price 2");
		expect(renderableTail("Done.\n")).toBe("Done.\n");
	});
});
