import { describe, expect, it } from "vitest";
import { formatTerminalRead, TERMINAL_READ_DEFINITION } from "./agent-tool";

const snapshot = (output: string, extra: object = {}) => ({
	id: "x",
	output,
	offset: output.length,
	exited: false,
	...extra,
});

describe("gui_terminal_read", () => {
	it("lists every terminal and returns the chosen one's last lines as plain text", () => {
		const text = formatTerminalRead(
			[
				snapshot("$ npm test\r\n\x1b[31mFAIL\x1b[0m src/a.test.ts\r\nprogress 10%\rprogress 100%\r\n$ \r\n"),
				snapshot("bye\r\n", { exited: true, exitCode: 0 }),
			],
			{ lines: 2 },
		);
		expect(text).toBe(
			"Terminal 1: running\nTerminal 2: exited 0\n\nTerminal 1, last 2 of 4 lines:\nprogress 100%\n$ ",
		);
	});

	it("says when there is no terminal or no such terminal", () => {
		expect(formatTerminalRead([], {})).toContain("no terminal open");
		expect(formatTerminalRead([snapshot("a\n")], { terminal: 3 })).toContain("There is no terminal 3.");
	});

	it("is registered read-only with a JSON schema stock accepts", () => {
		expect(TERMINAL_READ_DEFINITION.name).toBe("gui_terminal_read");
		expect(TERMINAL_READ_DEFINITION.parameters).toMatchObject({ type: "object", additionalProperties: false });
	});
});
