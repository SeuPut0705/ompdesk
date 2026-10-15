/**
 * C115: the read-only `gui_terminal_read` host tool. Every tab's omp gets it
 * through stock RPC `set_host_tools` once ready; a call reads that tab's own
 * Terminal panel sessions (a paired host's tab: the host's) and returns their
 * recent output as plain text. It never writes to a terminal.
 */
import { stripVTControlCharacters } from "node:util";
import type { HostToolDefinition } from "../../shared/rpc-types";
import type { TerminalSnapshot } from "../../shared/terminal-types";

export const TERMINAL_READ_TOOL = "gui_terminal_read";
const DEFAULT_LINES = 200;
const MAX_LINES = 2_000;

export const TERMINAL_READ_DEFINITION: HostToolDefinition = {
	name: TERMINAL_READ_TOOL,
	label: "Read terminal",
	description:
		"Read the recent output of the user's terminals in OMPdesk's Terminal panel for this tab (read-only; it cannot type or run anything). " +
		"Use it when the user refers to something in their terminal: an error, a server log, a command they ran. " +
		"Lists every terminal with its state and returns the last lines of the chosen one (default: the first).",
	parameters: {
		type: "object",
		properties: {
			terminal: { type: "integer", minimum: 1, description: "1-based terminal number as listed; default 1." },
			lines: {
				type: "integer",
				minimum: 1,
				maximum: MAX_LINES,
				description: `How many trailing lines to return; default ${DEFAULT_LINES}.`,
			},
		},
		additionalProperties: false,
	},
};

/** The tool's text for one tab's terminals (`snapshots` from a full `list`). */
export function formatTerminalRead(snapshots: TerminalSnapshot[], args: Record<string, unknown>): string {
	if (snapshots.length === 0) return "The user has no terminal open in this tab's Terminal panel.";
	const state = (item: TerminalSnapshot) =>
		item.error ? `failed: ${item.error}` : item.exited ? `exited ${item.exitCode ?? "?"}` : "running";
	const header = snapshots.map((item, index) => `Terminal ${index + 1}: ${state(item)}`).join("\n");
	const pick = typeof args.terminal === "number" && Number.isInteger(args.terminal) ? args.terminal : 1;
	const chosen = snapshots[pick - 1];
	if (!chosen) return `${header}\n\nThere is no terminal ${pick}.`;
	const wanted = typeof args.lines === "number" && Number.isInteger(args.lines) ? args.lines : DEFAULT_LINES;
	const count = Math.min(MAX_LINES, Math.max(1, wanted));
	const lines = stripVTControlCharacters(chosen.output)
		.replace(/\r+\n/g, "\n")
		.split("\n")
		.map(line => line.slice(line.lastIndexOf("\r") + 1));
	while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
	const tail = lines.slice(-count);
	const omitted = lines.length - tail.length;
	return `${header}\n\nTerminal ${pick}, ${omitted > 0 ? `last ${tail.length} of ${lines.length} lines` : `${tail.length} lines`}:\n${tail.join("\n")}`;
}
