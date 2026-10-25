import { describe, expect, it } from "vitest";
import type { AgentMessage, MessageContent, ToolCallContent } from "../../../../shared/rpc-types";
import { groupSteps, type StepRow, stepIntent } from "./work-steps";

function call(id: string, name: string, args: Record<string, unknown> = {}, intent?: string): ToolCallContent {
	return { type: "toolCall", id, name, arguments: args, ...(intent ? { intent } : {}) };
}

let clock = 0;
function assistant(content: MessageContent[], extra: Partial<AgentMessage> = {}): AgentMessage {
	return { role: "assistant", content, timestamp: ++clock, ...extra } as AgentMessage;
}

const result = (id: string): AgentMessage =>
	({ role: "toolResult", toolCallId: id, content: [], timestamp: ++clock }) as unknown as AgentMessage;

const readTarget = (path: string) => ({ __ompReadGroup: { path } });

/** A row as a short word: `call:id`, `reads:a+b`, `intent:label[...]`, `text`, `thinking`; `^N` = N thoughts folded in. */
function shape(row: StepRow): string {
	const folded = row.kind !== "message" && row.thoughts ? `^${row.thoughts.length}` : "";
	if (row.kind === "call") return `call:${row.call.id}${folded}`;
	if (row.kind === "reads") return `reads:${row.entries.map(entry => entry.callId).join("+")}${folded}`;
	if (row.kind === "intent") return `intent:${row.label}[${row.items.map(shape).join(",")}]${folded}`;
	return row.thinkingOnly ? "thinking" : "text";
}

describe("stepIntent", () => {
	it("reads stock's wire intent, then the arguments' own, and skips a generic one", () => {
		expect(stepIntent(call("a", "bash", {}, " Checking types "))).toBe("Checking types");
		expect(stepIntent(call("a", "bash", { intent: "From args" }))).toBe("From args");
		expect(stepIntent(call("a", "wait", { i: "Waiting" }))).toBe("Waiting");
		expect(stepIntent(call("a", "bash", { command: "ls" }, "Running requested command"))).toBeUndefined();
		expect(stepIntent(call("a", "bash", {}))).toBeUndefined();
	});
});

describe("groupSteps", () => {
	it("lines consecutive calls of one intent up under one row, across messages and their results", () => {
		const rows = groupSteps([
			assistant([call("a", "bash", {}, "Checking the types")]),
			result("a"),
			assistant([call("b", "bash", {}, "checking the types"), call("c", "bash", {}, "Checking the types")]),
			result("b"),
			result("c"),
			assistant([call("d", "edit", {}, "Fixing the type")]),
		]);
		expect(rows.map(shape)).toEqual(["intent:Checking the types[call:a,call:b,call:c]", "call:d"]);
		const group = rows[0];
		expect(group?.kind === "intent" && group.callKeys).toEqual(["a", "b", "c"]);
	});

	it("leaves a lone call and calls without an intent as rows of their own", () => {
		const rows = groupSteps([
			assistant([
				call("a", "bash", {}, "One"),
				call("b", "bash", {}, "Two"),
				call("c", "bash", {}),
				call("d", "bash", {}),
			]),
		]);
		expect(rows.map(shape)).toEqual(["call:a", "call:b", "call:c", "call:d"]);
	});

	it("lets thinking sit inside a group, folded into the call after it, and ends the group at a visible reply", () => {
		const thinking: MessageContent = { type: "thinking", thinking: "hmm" };
		const text: MessageContent = { type: "text", text: "Looks fine so far." };
		expect(
			groupSteps([
				assistant([call("a", "bash", {}, "Running tests")]),
				assistant([thinking, call("b", "bash", {}, "Running tests")]),
				assistant([text, call("c", "bash", {}, "Running tests")]),
				assistant([call("d", "bash", {}, "Running tests")]),
			]).map(shape),
		).toEqual(["intent:Running tests[call:a,call:b^1]", "text", "intent:Running tests[call:c,call:d]"]);
	});

	it("folds the thoughts before a step into its row, the group's row too, and keeps them in order", () => {
		const first: MessageContent = { type: "thinking", thinking: "first" };
		const second: MessageContent = { type: "thinking", thinking: "second" };
		const rows = groupSteps([
			assistant([first]),
			assistant([second, call("a", "bash", {}, "Same"), call("b", "bash", {}, "Same")]),
			assistant([{ type: "thinking", thinking: "third" }, call("c", "bash", {}, "Other")]),
		]);
		expect(rows.map(shape)).toEqual(["intent:Same[call:a,call:b]^2", "call:c^1"]);
		const group = rows[0];
		expect(group?.kind === "intent" && group.thoughts?.map(message => message.content)).toEqual([[first], [second]]);
	});

	it("keeps a run of thoughts no step follows as one row, at the end and before a reply", () => {
		const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.01 } };
		const rows = groupSteps([
			assistant([call("a", "bash", {})]),
			assistant([{ type: "thinking", thinking: "one" }]),
			assistant([{ type: "thinking", thinking: "two" }]),
			assistant([{ type: "text", text: "Done." }]),
			assistant([{ type: "thinking", thinking: "three" }], { usage, duration: 3000 }),
			assistant([{ type: "thinking", thinking: "four" }], { usage, duration: 3000 }),
		]);
		expect(rows.map(shape)).toEqual(["call:a", "thinking", "text", "thinking"]);
		const merged = rows.map(row => (row.kind === "message" && row.thinkingOnly ? row.message : null));
		expect(merged[1]?.content).toEqual([{ type: "thinking", thinking: "one\n\ntwo" }]);
		expect(merged[3]?.content).toEqual([{ type: "thinking", thinking: "three\n\nfour" }]);
		expect(merged[3]?.usage).toEqual({
			input: 2,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 6,
			cost: { total: 0.02 },
		});
		// Time adds up with the tokens, so the merged row's rate stays the run's own.
		expect(merged[3]?.duration).toBe(6000);
	});

	it("folds two or more consecutive collapsible reads into the read group, inside and outside an intent", () => {
		const rows = groupSteps([
			assistant([
				call("r1", "read", readTarget("a.ts")),
				call("r2", "read", readTarget("b.ts")),
				call("e", "edit", {}, "Fixing"),
				call("r3", "read", readTarget("c.ts"), "Looking around"),
				call("r4", "read", readTarget("d.ts"), "Looking around"),
				call("g", "grep", {}, "Looking around"),
				call("r5", "read", readTarget("e.ts"), "Looking around"),
				call("r6", "read", readTarget("f.ts")),
			]),
		]);
		expect(rows.map(shape)).toEqual([
			"reads:r1+r2",
			"call:e",
			"intent:Looking around[reads:r3+r4,call:g,call:r5]",
			"call:r6",
		]);
		const group = rows[2];
		expect(group?.kind === "intent" && group.callKeys).toEqual(["r3", "r4", "g", "r5"]);
	});

	it("shows a group made only of folded reads as the read group itself, led by their intent", () => {
		const rows = groupSteps([
			assistant([
				call("r1", "read", readTarget("a.ts"), "Reading the sources"),
				call("r2", "read", readTarget("b.ts"), "Reading the sources"),
			]),
		]);
		expect(rows.map(shape)).toEqual(["reads:r1+r2"]);
		expect(rows[0]?.kind === "reads" && rows[0].intent).toBe("Reading the sources");
	});

	it("takes a read's target from the messages store's metadata when the call carries none", () => {
		const rows = groupSteps(
			[
				assistant([
					call("r1", "read", { path: "a.ts" }),
					call("r2", "read", { path: "b.ts" }),
					call("r3", "read", { path: "c.ts" }),
				]),
			],
			new Map([
				["r1", { path: "a.ts" }],
				["r2", { path: "b.ts" }],
				["r3", null],
			]),
		);
		expect(rows.map(shape)).toEqual(["reads:r1+r2", "call:r3"]);
	});

	it("splits a message around its calls with the same block objects, and keeps the usage under the last piece", () => {
		const block = call("a", "bash", {}, "Only");
		const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.01 } };
		const rows = groupSteps([
			assistant([{ type: "text", text: "Before." }, block], { usage }),
			assistant([{ type: "text", text: "After." }], { usage }),
		]);
		expect(rows.map(shape)).toEqual(["text", "call:a", "text"]);
		const [first, second, third] = rows;
		expect(first?.kind === "message" && first.message.usage).toBeUndefined();
		expect(second?.kind === "call" && second.call).toBe(block);
		expect(second?.kind === "call" && second.usage?.usage).toBe(usage);
		expect(third?.kind === "message" && third.message.usage).toBe(usage);
	});

	it("never splits a failed or steering reply and drops nothing else", () => {
		const failed = assistant([call("a", "bash", {}, "Same"), call("b", "bash", {}, "Same")], {
			errorMessage: "boom",
		});
		const note = {
			role: "custom",
			customType: "irc",
			content: "hi",
			display: true,
			timestamp: ++clock,
		} as AgentMessage;
		const rows = groupSteps([failed, note]);
		expect(rows.map(shape)).toEqual(["text", "text"]);
		expect(rows[0]?.kind === "message" && rows[0].message).toBe(failed);
	});
});
