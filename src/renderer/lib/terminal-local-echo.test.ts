/** C109: typed characters on a paired host's terminal paint once the shell has proven it echoes them. */

import { describe, expect, it } from "vitest";
import { cellWidth, TerminalLocalEcho } from "./terminal-local-echo";

function setup(anchor: number | null = 2) {
	const written: string[] = [];
	let now = 0;
	const echo = new TerminalLocalEcho({
		write: data => written.push(data),
		anchor: () => anchor,
		cols: () => 80,
		now: () => now,
	});
	return { echo, written, advance: (ms: number) => (now += ms) };
}

describe("TerminalLocalEcho", () => {
	it("paints nothing until two echoes matched, then paints and swallows the confirmed echo", () => {
		const { echo, written } = setup();
		echo.input("l");
		expect(echo.output("l")).toBe("l");
		echo.input("s");
		expect(echo.output("s")).toBe("s");
		expect(written).toEqual([]);
		echo.input(" ");
		expect(written).toEqual([" "]);
		expect(echo.output(" ")).toBe("");
		echo.dispose();
	});

	it("passes colours through, and erases the painted region when the host disagrees", () => {
		const { echo, written } = setup(4);
		for (const key of ["a", "b"]) {
			echo.input(key);
			echo.output(key);
		}
		echo.input("c");
		echo.input("d");
		expect(written).toEqual(["c", "d"]);
		expect(echo.output("\x1b[31mc")).toBe("\x1b[31m");
		// A repaint instead of "d": the painted "d" (from column 5) is erased first.
		expect(echo.output("\r\x1b[Kprompt")).toBe("\x1b[6G\x1b[K\r\x1b[Kprompt");
		echo.dispose();
	});

	it("predicts a backspace over a painted character and matches the shell's erase echo", () => {
		const { echo, written } = setup();
		for (const key of ["a", "b"]) {
			echo.input(key);
			echo.output(key);
		}
		echo.input("x");
		echo.input("\x7f");
		expect(written).toEqual(["x", "\b \b"]);
		expect(echo.output("x\b \b")).toBe("");
		echo.dispose();
	});

	it("never paints when the cursor is not at the end of a normal-buffer line", () => {
		const { echo, written } = setup(null);
		for (const key of ["a", "b", "c"]) {
			echo.input(key);
			expect(echo.output(key)).toBe(key);
		}
		expect(written).toEqual([]);
		echo.dispose();
	});

	it("drops predictions the host never echoes after 2 s", () => {
		const { echo, written, advance } = setup();
		for (const key of ["a", "b"]) {
			echo.input(key);
			echo.output(key);
		}
		echo.input("z");
		advance(2_100);
		expect(echo.output("later")).toBe("later");
		expect(written).toEqual(["z", "\x1b[3G\x1b[K"]);
		echo.dispose();
	});

	it("counts wide characters as two cells", () => {
		expect(cellWidth("한")).toBe(2);
		expect(cellWidth("a")).toBe(1);
	});
});
