import { describe, expect, it } from "vitest";
import { hasAnsi, parseAnsi } from "./ansi";

describe("parseAnsi", () => {
	it("passes plain text through as one unstyled segment", () => {
		expect(parseAnsi("hello world")).toEqual([{ text: "hello world" }]);
	});

	it("parses a colored run and reset", () => {
		expect(parseAnsi("\x1b[31merror\x1b[0m ok")).toEqual([
			{ text: "error", fg: "var(--omp-ansi-red)" },
			{ text: " ok" },
		]);
	});

	it("carries style state across segments until reset", () => {
		const segments = parseAnsi("\x1b[1;32mPASS\x1b[39m still-bold\x1b[0m");
		expect(segments[0]).toMatchObject({ text: "PASS", fg: "var(--omp-ansi-green)", bold: true });
		expect(segments[1]).toMatchObject({ text: " still-bold", bold: true });
		expect(segments[1].fg).toBeUndefined();
	});

	it("maps bright foreground colors", () => {
		expect(parseAnsi("\x1b[91mx")[0]).toMatchObject({ fg: "var(--omp-ansi-bright-red)" });
	});

	it("maps background colors", () => {
		expect(parseAnsi("\x1b[44mx")[0]).toMatchObject({ bg: "var(--omp-ansi-blue)" });
	});

	it("resolves 256-palette indexes, delegating low indexes to theme vars", () => {
		expect(parseAnsi("\x1b[38;5;9mx")[0]).toMatchObject({ fg: "var(--omp-ansi-bright-red)" });
		expect(parseAnsi("\x1b[38;5;196mx")[0]).toMatchObject({ fg: "rgb(255 0 0)" });
		expect(parseAnsi("\x1b[48;5;238mx")[0]).toMatchObject({ bg: "rgb(68 68 68)" });
	});

	it("resolves 24-bit truecolor", () => {
		expect(parseAnsi("\x1b[38;2;12;34;56mx")[0]).toMatchObject({ fg: "rgb(12 34 56)" });
	});

	it("handles text styles and their explicit resets", () => {
		const segments = parseAnsi("\x1b[1;3;4;9mx\x1b[22;23;24;29my");
		expect(segments[0]).toMatchObject({ bold: true, italic: true, underline: true, strikethrough: true });
		expect(segments[1]).toEqual({ text: "y" });
	});

	it("strips cursor-control and other non-SGR CSI sequences", () => {
		expect(parseAnsi("a\x1b[2Kb\x1b[1;1Hc")).toEqual([{ text: "abc" }]);
	});

	it("strips OSC titles and two-byte escapes", () => {
		expect(parseAnsi("\x1b]0;window title\x07hi\x1b(B")).toEqual([{ text: "hi" }]);
	});

	it("turns OSC 8 hyperlinks into href segments and closes them", () => {
		const segments = parseAnsi("\x1b]8;;https://example.com\x07link text\x1b]8;;\x07 plain");
		expect(segments[0]).toMatchObject({ text: "link text", href: "https://example.com" });
		expect(segments[1]).toEqual({ text: " plain" });
	});
	it("never renders non-http(s) OSC 8 uris as anchors", () => {
		// New-window activation bypasses the click-path openExternal check, so
		// unsafe schemes must not become <a href> at all.
		const segments = parseAnsi("\x1b]8;;file:///etc/passwd\x07link\x1b]8;;\x07");
		expect(segments).toEqual([{ text: "link" }]);
	});

	it("normalizes CRLF", () => {
		expect(parseAnsi("a\r\nb")).toEqual([{ text: "a\nb" }]);
	});

	it("replays carriage-return overwrite semantics for progress lines", () => {
		// Positional overwrite, exactly like a terminal: shorter final frames do
		// not erase leftover characters (real progress bars pad or emit CSI K).
		expect(parseAnsi("10%\r20%\r100% done\nnext")).toEqual([{ text: "100% done\nnext" }]);
		expect(parseAnsi("Downloading\rDone")).toEqual([{ text: "Doneloading" }]);
	});

	it("applies CSI K erase semantics during carriage-return replay", () => {
		// Terminal shows `Done`; the old positional replay leaked `[K` garbage.
		expect(parseAnsi("Downloading\rDone\x1b[K")).toEqual([{ text: "Done" }]);
		expect(parseAnsi("80%\r100%\x1b[K\nnext")).toEqual([{ text: "100%\nnext" }]);
	});

	it("preserves active styles while replaying overwritten text", () => {
		expect(parseAnsi("\x1b[31mold\rnew\x1b[0m")).toEqual([{ text: "new", fg: "var(--omp-ansi-red)" }]);
	});

	it("keeps content when a line ends in a bare carriage return", () => {
		expect(parseAnsi("finished\r")).toEqual([{ text: "finished" }]);
	});

	it("strips stray C0 control characters but keeps tabs", () => {
		expect(parseAnsi("a\x00b\x07c\td")).toEqual([{ text: "abc\td" }]);
	});

	it("merges adjacent plain text into a single segment", () => {
		const segments = parseAnsi("a\x1b[2Kb\x1b[31mc\x1b[0md");
		expect(segments[0]).toEqual({ text: "ab" });
		expect(segments[2]).toEqual({ text: "d" });
	});
});

describe("hasAnsi", () => {
	it("detects escape sequences", () => {
		expect(hasAnsi("\x1b[31mx")).toBe(true);
		expect(hasAnsi("plain $PATH [32m")).toBe(false);
	});
});
