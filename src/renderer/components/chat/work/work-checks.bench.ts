import { bench, describe } from "vitest";
import { commandOperation, type OperationCall, settleFailures, summarizeChecks } from "./work-checks";

// 226 synthetic turns shaped like the replayed ones (about 45 calls each: edits, some rejected and redone, commands,
// checks and probes); the real journals stay out of the public repository.
const turns = Array.from({ length: 226 }, (_, turn) =>
	Array.from({ length: 45 }, (_, index): OperationCall & { command?: string } => {
		const failed = (turn + index) % 7 === 0;
		if (index % 3 === 0)
			return { toolName: "edit", args: { path: `src/file-${index % 9}.ts` }, outcome: failed ? "failed" : "passed" };
		const command = index % 5 === 0 ? "bun run check:types 2>&1 | tail -20" : `git log --oneline -${index % 4}`;
		return commandOperation({ command, failed, exitCode: failed ? 1 : 0, text: failed ? "error TS2322" : "" });
	}),
);

describe("the verdict over 226 turns", () => {
	bench("settleFailures and summarizeChecks", () => {
		for (const calls of turns) {
			settleFailures(calls, "/repo");
			summarizeChecks(
				calls.flatMap(call =>
					typeof call.args.command === "string"
						? [{ command: call.args.command, failed: call.outcome === "failed", exitCode: null }]
						: [],
				),
				"/repo",
			);
		}
	});
});
