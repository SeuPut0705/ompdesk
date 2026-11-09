import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAgent, sse, startOmp, startProvider, toolCall } from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * The waste guards (waste-guards.ts) on the installed omp with a scripted provider, no spend:
 * a service start whose `ready.log` cannot match is refused before it runs (it would wait `ready.timeout`), and the
 * first poll gets the hint in the request after its result, the second poll none.
 */

const REFUSED = "ready.log can never match";
const HINT = "OMPdesk: this polled.";
const EDIT_HINT_START = "OMPdesk: this edit was refused.";

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

describe.skipIf(!existsSync(omp))("waste guards, on stock omp", () => {
	it("refuses a ready.log that cannot match at once, without running the command", async () => {
		const script = [
			toolCall("bash", {
				command: "sleep 120 > x.log 2>&1",
				name: "tests",
				ready: { log: "Running \\d+ tests", timeout: 600 },
			}),
		];
		const provider = await startProvider(step =>
			step <= script.length ? sse(script[step - 1], "tool_calls") : sse([{ content: "DONE" }], "stop"),
		);
		const session = await startOmp({
			...fakeAgent(provider.url),
			model: "fake/m1",
			bridge: resolve("resources/gui-bridge/index.ts"),
		});
		const started = Date.now();
		await session.turn("Run the tests as a service");
		// Without the guard this call waits the whole 600 s.
		expect(Date.now() - started).toBeLessThan(60_000);
		expect(provider.bodies[1]).toContain(REFUSED);
		expect(existsSync(join(session.root, "x.log"))).toBe(false);
	}, 180_000);

	it("hints at the first poll of a kind only", async () => {
		const poll = { command: "sleep 0.1; echo POLLRESULT" };
		const script = [toolCall("bash", poll), toolCall("bash", poll)];
		const provider = await startProvider(step =>
			step <= script.length ? sse(script[step - 1], "tool_calls") : sse([{ content: "DONE" }], "stop"),
		);
		const session = await startOmp({
			...fakeAgent(provider.url),
			model: "fake/m1",
			bridge: resolve("resources/gui-bridge/index.ts"),
		});
		const frames = await session.turn("Look twice");
		// The first result carries the hint at its end; the second is the command's output alone.
		const results = frames
			.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "bash")
			.map(frame => JSON.stringify(frame.result));
		expect(results).toHaveLength(2);
		expect(results[0]).toContain(HINT);
		expect(results[0]?.indexOf(HINT)).toBeGreaterThan(results[0]?.indexOf("POLLRESULT") ?? Number.POSITIVE_INFINITY);
		expect(results[1]).toContain("POLLRESULT");
		expect(results[1]).not.toContain(HINT);
		const [, afterFirst, afterSecond] = provider.bodies;
		expect(occurrences(afterFirst, HINT)).toBe(1);
		// The first hint stays in the history; the second call adds none.
		expect(occurrences(afterSecond, HINT)).toBe(1);
	}, 180_000);

	it("hints once at an edit anchored to lines the session never read", async () => {
		const blind = { input: "[notes.txt#0000]\nPUT 2.=2:\n+changed" };
		const script = [
			toolCall("bash", { command: "printf 'one\\ntwo\\nthree\\n' > notes.txt" }),
			toolCall("edit", blind),
			toolCall("edit", blind),
		];
		const provider = await startProvider(step =>
			step <= script.length ? sse(script[step - 1], "tool_calls") : sse([{ content: "DONE" }], "stop"),
		);
		const session = await startOmp({
			...fakeAgent(provider.url),
			model: "fake/m1",
			bridge: resolve("resources/gui-bridge/index.ts"),
		});
		const frames = await session.turn("Edit without reading");
		const results = frames
			.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "edit")
			.map(frame => JSON.stringify(frame.result));
		expect(results).toHaveLength(2);
		expect(results[0]).toContain(EDIT_HINT_START);
		expect(results[1]).not.toContain(EDIT_HINT_START);
	}, 180_000);

	it("blocks a wait until the job it watches finishes, past stock's first windows", async () => {
		// The output is computed, so the job's label (the command) never contains it.
		const script = [
			toolCall("bash", { command: "sleep 12; echo JOB_$((40 + 2))", async: true }),
			toolCall("wait", {}),
		];
		const provider = await startProvider(step =>
			step <= script.length ? sse(script[step - 1], "tool_calls") : sse([{ content: "DONE" }], "stop"),
		);
		const session = await startOmp({
			...fakeAgent(provider.url),
			model: "fake/m1",
			bridge: resolve("resources/gui-bridge/index.ts"),
		});
		const frames = await session.turn("Start a job and wait for it");
		const waits = frames
			.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "wait")
			.map(frame => JSON.stringify(frame.result));
		// Stock's wait returns after its 5 s window with the job still running, and the model is asked again for nothing.
		expect(waits).toHaveLength(1);
		expect(waits[0]).toContain("JOB_42");
		expect(provider.bodies[2]).toContain("JOB_42");
		expect(provider.bodies[2]).not.toContain("Still Running");
	}, 180_000);

	it("still ends a blocked wait at once when a message comes in", async () => {
		const script = [toolCall("bash", { command: "sleep 90; echo LATE", async: true }), toolCall("wait", {})];
		const provider = await startProvider(step =>
			step <= script.length ? sse(script[step - 1], "tool_calls") : sse([{ content: "DONE" }], "stop"),
		);
		const session = await startOmp({
			...fakeAgent(provider.url),
			model: "fake/m1",
			bridge: resolve("resources/gui-bridge/index.ts"),
		});
		const from = session.frames.length;
		void session.turn("Start a long job and wait for it");
		await expect
			.poll(() => session.frames.slice(from).some(f => f.type === "tool_execution_start" && f.toolName === "wait"), {
				timeout: 60_000,
			})
			.toBe(true);
		await session.send({ type: "steer", message: "Stop waiting and answer" });
		// Far inside the job's 90 s: only the message can have ended the wait.
		await expect
			.poll(() => session.frames.slice(from).find(f => f.type === "tool_execution_end" && f.toolName === "wait"), {
				timeout: 30_000,
			})
			.toBeDefined();
		const ended = session.frames
			.slice(from)
			.find(frame => frame.type === "tool_execution_end" && frame.toolName === "wait");
		expect(JSON.stringify(ended?.result)).toContain("interrupted by message");
	}, 180_000);
});
