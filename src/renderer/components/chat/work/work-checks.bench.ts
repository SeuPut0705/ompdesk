/**
 * The finished card's verdict over 226 synthetic turns: the ledger (`workOutcomes`) and the verdict (`workVerdict`),
 * as `ExecutionGroup` runs them. Entries are hydrated through the tools store with unique command and output text;
 * building them is outside the timed body.
 */
import { bench, describe } from "vitest";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { createToolsStore, type ToolEntry } from "../../../stores/tools";
import { workVerdict } from "./work-checks";
import { stepOperations } from "./work-findings";
import { workOutcomes } from "./work-view";

type Call = { name: string; args: Record<string, unknown>; text: string; isError: boolean; exitCode?: number };

function turnCalls(turn: number): Call[] {
	return Array.from({ length: 45 }, (_, index): Call => {
		const failed = (turn * 7 + index) % 9 === 0;
		const tag = `${turn}-${index}`;
		switch (index % 9) {
			case 0:
			case 1:
				return {
					name: "edit",
					args: {
						path: `src/area-${turn % 13}/file-${index % 6}.ts`,
						edits: [{ old_text: tag, new_text: `${tag}!` }],
					},
					text: failed ? `Edit rejected: old text ${tag} not found` : `Updated ${tag}`,
					isError: failed,
				};
			case 2:
				return {
					name: "bash",
					args: { command: `bun run check:types 2>&1 | tail -${index}`, cwd: `packages/p${turn % 4}` },
					text: failed ? `src/x${tag}.ts(3,3): error TS2322: nope\nCommand exited with code 2` : `ok ${tag}`,
					isError: failed,
					exitCode: failed ? 2 : 0,
				};
			case 3:
				return {
					name: "bash",
					args: { command: `bunx vitest run src/t${tag}.test.ts` },
					text: failed ? ` FAIL t${tag}\n Tests  1 failed (4)` : ` Tests  ${index} passed (${index})`,
					isError: failed,
					exitCode: failed ? 1 : 0,
				};
			case 4:
				return {
					name: "bash",
					args: { command: `git log --oneline -${index} -- src/${tag}` },
					text: `a1b2c3 change ${tag}`,
					isError: false,
					exitCode: 0,
				};
			case 5:
				return {
					name: "bash",
					args: { command: `command -v tool${tag}` },
					text: "",
					isError: failed,
					exitCode: failed ? 1 : 0,
				};
			case 6:
				return {
					name: "eval",
					args: { language: "py", code: `print(${index})  # ${tag}` },
					text: `${index}`,
					isError: failed,
				};
			case 7:
				return {
					name: "task",
					args: { tasks: [{ name: `T${tag}`, task: `look at ${tag}` }] },
					text: "done",
					isError: false,
				};
			default:
				return {
					name: "write",
					args: { path: "xd://ompdesk_report", content: JSON.stringify({ kind: "progress", text: tag }) },
					text: "Delivered",
					isError: failed,
				};
		}
	});
}

function hydrate(turn: number): [string, ToolEntry][] {
	const store = createToolsStore();
	const messages = turnCalls(turn).flatMap((call, index): AgentMessage[] => [
		{
			role: "assistant",
			timestamp: index * 10 + 1,
			content: [{ type: "toolCall", id: `c${turn}-${index}`, name: call.name, arguments: call.args }],
		},
		{
			role: "toolResult",
			toolCallId: `c${turn}-${index}`,
			toolName: call.name,
			timestamp: index * 10 + 2,
			content: [{ type: "text", text: call.text }],
			details: call.exitCode === undefined ? undefined : { exitCode: call.exitCode },
			isError: call.isError,
		},
	]);
	store.getState().hydrateMessages(messages);
	return [...store.getState().finishedTools];
}

const turns = Array.from({ length: 226 }, (_, turn) => hydrate(turn));
describe("the finished card's verdict over 226 turns", () => {
	bench("workOutcomes + workVerdict", () => {
		for (const entries of turns) {
			const outcome = workOutcomes(
				entries.map(([toolCallId, entry]) => ({ entry, toolCallId })),
				undefined,
				"/repo",
			);
			workVerdict(outcome.commands, "/repo", stepOperations(entries));
		}
	});
});
