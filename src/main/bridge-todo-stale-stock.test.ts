import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STALE_TODO_MESSAGE_TYPE } from "../../resources/gui-bridge/todo-stale-core";
import {
	bridgeAt,
	type Frame,
	fakeAgent,
	realAgent,
	sse,
	startOmp,
	startProvider,
	todoOps,
	toolCall,
} from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * A long session takes request after request and kept one finished task's todo list on the work board for hours:
 * stock reminds about a list only to finish it, never when a new request arrives. The bridge (todo-stale.ts) names a
 * stale list to the agent once, as a hidden message at the start of the turn a new request opens.
 *
 * 1. Installed omp, scripted provider, no spend: a finished list meets a new request (the reminder reaches the model in
 *    that turn's request), then a question (nothing new), then another request after a reminder (nothing new).
 * 2. Opt-in (`OMP_GUI_REAL_WORK=1`, `TODO_STALE_BEFORE_REF=<commit before the feature>`): the user's real `smol`
 *    model finishes a listed task, then gets two new requests and a question, on the bridge of that commit and on
 *    this one; prints `TODO_STALE_REAL` lines with the todo ops of each turn and whether a reminder came.
 */

function reminders(frames: readonly Frame[]): number {
	return frames.filter(frame => frame.type === "message_end" && frame.message?.customType === STALE_TODO_MESSAGE_TYPE)
		.length;
}

describe.skipIf(!existsSync(omp))("a todo list left from earlier work, on stock omp", () => {
	it("is named to the model once, in the turn a new request opens, and never for a question", async () => {
		// First prompt: a list, all of it done, an answer. Every later main request: a plain answer.
		const provider = await startProvider(step =>
			step === 1
				? sse(toolCall("todo", { op: "init", list: [{ phase: "Sidebar bug", items: ["a", "b"] }] }), "tool_calls")
				: step === 2
					? sse(toolCall("todo", { op: "done", phase: "Sidebar bug" }), "tool_calls")
					: sse([{ content: "DONE" }], "stop"),
		);
		const session = await startOmp({
			...fakeAgent(provider.url),
			model: "fake/m1",
			bridge: resolve("resources/gui-bridge/index.ts"),
		});
		const first = await session.turn("Fix the sidebar bug and add a test for it");
		expect(todoOps(first)).toEqual(["init", "done"]);
		expect(reminders(first)).toBe(0);

		const request = await session.turn("Add a Korean label to the export button and a test for it");
		expect(reminders(request)).toBe(1);
		const sent = provider.bodies.at(-1) ?? "";
		expect(sent).toContain('Your todo list (\\"Sidebar bug\\", 2/2 done) is finished');
		// After the person's prompt: the cached prefix in front of it stays as it was.
		expect(sent.indexOf("is finished")).toBeGreaterThan(sent.indexOf("Add a Korean label"));

		const question = await session.turn("why did the build fail?");
		expect(reminders(question)).toBe(0);
		const again = await session.turn("Rename the export button to Download in every locale");
		expect(reminders(again)).toBe(0);
	}, 180_000);
});

const real =
	process.env.OMP_GUI_REAL_WORK === "1" && process.env.TODO_STALE_BEFORE_REF !== undefined && existsSync(omp);
const RUNS = Number(process.env.TODO_STALE_REAL_RUNS ?? 2);

const SCRIPT = [
	{
		kind: "task",
		text: "Create notes.md with three bullet points about Bun, then count.txt holding the number 3. Track the two steps in your todo list and mark each done.",
	},
	{
		kind: "request",
		text: "Now add hello.ts exporting greet(name) that returns 'Hello, ' + name, and hello.test.ts with one bun test for it. Run the test.",
	},
	{ kind: "question", text: "What does greet return for an empty name?" },
	{ kind: "request", text: "Rename greet to welcome in hello.ts and hello.test.ts and run the test again." },
] as const;

describe.skipIf(!real)("a todo list left from earlier work, on the user's real smol model", () => {
	it("is replaced or updated on the first new request", async () => {
		const results: Array<Record<string, unknown>> = [];
		for (let run = 0; run < RUNS; run++)
			for (const [variant, bridge] of [
				["before", bridgeAt(process.env.TODO_STALE_BEFORE_REF ?? "")],
				["after", resolve("resources/gui-bridge/index.ts")],
			] as const) {
				const { agentDir, isolated, smol } = realAgent();
				const session = await startOmp({ agentDir, isolated, model: smol, bridge });
				const turns: Array<{ kind: string; ops: string[]; reminder: number }> = [];
				for (const step of SCRIPT) {
					const frames = await session.turn(step.text);
					turns.push({ kind: step.kind, ops: todoOps(frames), reminder: reminders(frames) });
				}
				const line = { run, variant, model: smol, turns };
				results.push(line);
				console.log(`TODO_STALE_REAL=${JSON.stringify(line)}`);
			}
		for (const line of results)
			if (line.variant === "after")
				for (const turn of line.turns as Array<{ kind: string; reminder: number }>)
					if (turn.kind === "question") expect(turn.reminder).toBe(0);
	}, 3_600_000);
});
