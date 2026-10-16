/// <reference types="bun" />
import * as fs from "node:fs";
import { createInterface } from "node:readline";

export function runModelSetup(): void {
	// `OMP_GUI_TEST_MODEL_SETUP=1`: the model setup assistant's research job, stock
	// `--mode rpc` (src/main/model-setup-runner.ts). It answers set_event_filter and
	// the prompt, streams two tool calls, then the stock-shaped reply (a plan in a
	// code fence, with one unknown role the parser drops) and the prompt_result.
	const expected = [
		"--mode",
		"rpc",
		"--no-session",
		"--model",
		"*",
		"--thinking",
		"auto",
		"--tools",
		"web_search,read",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-lsp",
		"--no-title",
	];
	const argv = process.argv.slice(2);
	if (
		argv.length !== expected.length ||
		argv.some((arg, index) => expected[index] !== "*" && arg !== expected[index])
	) {
		console.error(`fixture: unexpected research argv: ${argv.join(" ")}`);
		process.exit(1);
	}
	const write = (frame: object) => process.stdout.write(`${JSON.stringify(frame)}\n`);
	const plan = {
		assignments: [
			{
				role: "default",
				model: "anthropic/claude-sonnet-4-5",
				reason: "Leads the coding benchmarks among the picks.",
			},
			{ role: "smol", model: "fixture/local-fixture", reason: "Fastest and cheapest pick." },
			{ role: "slow", model: "anthropic/claude-sonnet-4-5", reason: "Strongest reasoning scores." },
			{ role: "plan", model: "anthropic/claude-sonnet-4-5", reason: "Best long-horizon planning results." },
			{ role: "advisor", model: "fixture/local-fixture", reason: "A different vendor than the default model." },
			{ role: "reviewer", model: "fixture/local-fixture", reason: "Not a role omp knows." },
		],
		advisor: { enable: true, reason: "A capable second vendor is available." },
		sources: [{ title: "Fixture leaderboard", url: "https://example.com/leaderboard" }],
		notes: "Canned fixture plan.",
	};
	const research = async (id: unknown) => {
		await Bun.sleep(600);
		write({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "web_search",
			args: { query: "coding benchmarks 2026" },
		});
		await Bun.sleep(600);
		write({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "t1", toolName: "web_search", content: [] },
		});
		write({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "read",
			args: { path: "https://example.com/leaderboard" },
		});
		await Bun.sleep(600);
		write({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Comparing the picks." },
					{ type: "text", text: `Here is the plan:\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`` },
				],
				stopReason: "stop",
			},
		});
		write({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
	};
	const lines = createInterface({ input: process.stdin });
	lines.on("line", line => {
		const command = JSON.parse(line) as { id?: unknown; type?: unknown; message?: unknown };
		if (process.env.OMP_GUI_TEST_RECORD)
			fs.appendFileSync(
				process.env.OMP_GUI_TEST_RECORD,
				`${JSON.stringify({ type: `research:${String(command.type)}`, argv, message: command.message, recordedBy: "model-setup" })}\n`,
			);
		write({ type: "response", id: command.id, command: command.type, success: true });
		if (command.type === "prompt") void research(command.id);
	});
	// Stock RPC mode ends when its client closes stdin.
	lines.on("close", () => process.exit(0));
}
