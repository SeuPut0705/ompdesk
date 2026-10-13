import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { type SubagentNode, useSubagentsStore } from "../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
Object.assign(window, {
	requestAnimationFrame: (callback: FrameRequestCallback) => {
		const id = ++sequence;
		frames.set(id, callback);
		return id;
	},
	cancelAnimationFrame: (id: number) => frames.delete(id),
	omp: { rpc: { command: async () => ({ success: true, data: { messages: [] } }) } },
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
// React DOM must initialize only after the linkedom browser globals exist.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek } = await import("./LiveStepPeek");
const { ExecutionGroup } = await import("./ExecutionGroup");
const { ProcessGroup, STREAMING_WORK_ROW } = await import("./ChatStream");
let root: Root;
let container: HTMLElement;

const call = (toolName: string, args: Record<string, unknown>, patch: Partial<ToolEntry> = {}): ToolEntry => ({
	toolName,
	args,
	streamingArgs: "",
	result: undefined,
	isError: false,
	status: "running",
	startTime: 1,
	endTime: null,
	...patch,
});
const agent = (id: string, index: number, parentToolCallId: string): SubagentNode => ({
	id,
	index,
	lastUpdate: 1,
	status: "running",
	agent: "scout",
	parentToolCallId,
});
async function flush() {
	const pending = [...frames.values()];
	frames.clear();
	await act(async () => {
		for (const callback of pending) callback(0);
		vi.advanceTimersToNextFrame();
	});
}
async function show(node: ReactNode) {
	await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
	await flush();
}
async function tools(entries: Array<readonly [string, ToolEntry]>) {
	await act(async () => useToolsStore.setState(toolEntriesState(entries)));
	await flush();
}
const narrative = () => container.querySelector(".omp-work-head [data-incoming] .omp-work-narrative")?.textContent;
const sub = () => container.querySelector(".omp-work-sub")?.textContent;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useToolsStore.getState().reset();
	useMessagesStore.getState().reset();
	useSubagentsStore.getState().reset();
	frames.clear();
	vi.useRealTimers();
});

describe("head sub line", () => {
	it("never repeats the agents the narrative already names", async () => {
		await tools([["task", call("task", { tasks: [{ name: "Scout" }, { name: "Review" }] })]]);
		await act(async () =>
			useSubagentsStore.getState().setSnapshots([agent("Scout", 0, "task"), agent("Review", 1, "task")]),
		);
		await show(<LiveStepPeek thinkingLive={false} toolCallIds={["task"]} />);
		expect(narrative()).toBe("Running Scout, Review");
		// Seen as "Running Scout, Review" over "Waiting for Scout, Review".
		expect(sub()).toBe("2 agents working");
	});

	it("never repeats a wait's own intent naming the agent", async () => {
		await tools([
			["task", call("task", { tasks: [{ name: "Sleeper" }] }, { status: "done", endTime: 2 })],
			["wait", call("wait", { i: "Waiting for Sleeper" }, { startTime: 3 })],
		]);
		await act(async () => useSubagentsStore.getState().setSnapshots([agent("Sleeper", 0, "task")]));
		await show(<LiveStepPeek thinkingLive={false} toolCallIds={["task", "wait"]} />);
		expect(narrative()).toBe("Waiting for Sleeper");
		expect(sub()).toBe("1 agent working");
	});

	it("still names the agents a wait does not", async () => {
		await tools([
			["task", call("task", { tasks: [{ name: "Alpha" }, { name: "Beta" }] }, { status: "done", endTime: 2 })],
			["wait", call("wait", { i: "Waiting for counters" }, { startTime: 3 })],
		]);
		await act(async () =>
			useSubagentsStore.getState().setSnapshots([agent("Alpha", 0, "task"), agent("Beta", 1, "task")]),
		);
		await show(<LiveStepPeek thinkingLive={false} toolCallIds={["task", "wait"]} />);
		expect(sub()).toBe("Waiting for Alpha, Beta");
	});

	it("names an untitled code cell's language, not its wire token", async () => {
		await tools([["eval", call("eval", { code: "1 + 1", language: "js" })]]);
		await show(<LiveStepPeek thinkingLive={false} toolCallIds={["eval"]} />);
		expect(narrative()).toBe("Run JavaScript");
		// Its sub line never repeats the language or title the narrative already states.
		expect(sub()).not.toContain("js");
		await tools([["eval", call("eval", { code: "1 + 1", language: "py", title: "Count rows" })]]);
		expect(narrative()).toBe("Count rows");
		expect(sub()).not.toContain("Count rows");
	});
});

describe("catch-up note", () => {
	it("does not outlive the live run", async () => {
		// Seen-step counts persist per store and group: ids unique to this test.
		await tools([["gone-a", call("bash", { command: "echo a" }, { status: "done", endTime: 1 })]]);
		await show(<LiveStepPeek thinkingLive={false} toolCallIds={["gone-a", "gone-b"]} />);
		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		await tools([
			["gone-a", call("bash", { command: "echo a" }, { status: "done", endTime: 1 })],
			["gone-b", call("bash", { command: "echo b" }, { startTime: 2 })],
		]);
		Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		expect(container.querySelector(".omp-work-catch-up")).not.toBeNull();
		await tools([
			["gone-a", call("bash", { command: "echo a" }, { status: "done", endTime: 1 })],
			["gone-b", call("bash", { command: "echo b" }, { startTime: 2, status: "error", isError: true, endTime: 3 })],
		]);
		await show(<LiveStepPeek thinkingLive={false} toolCallIds={["gone-a", "gone-b"]} state="failed" />);
		expect(container.querySelector(".omp-work-catch-up")).toBeNull();
	});
});

describe("stop between steps", () => {
	it("reads as interrupted when the user stopped the run while no call was running", async () => {
		// Seen in a real run: stock backgrounded the command, it returned OK, and the user stopped
		// the model's next request. Stock's empty aborted reply is the stop; nothing was cut mid-call.
		await tools([["bash", call("bash", { command: "sleep 40" }, { status: "done", endTime: 5_000 })]]);
		await show(
			<ExecutionGroup
				expanded={false}
				onExpandedChange={() => {}}
				stepCount={1}
				toolCallIds={["bash"]}
				stoppedAt={9_000}
			>
				<div />
			</ExecutionGroup>,
		);
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-state")).toBe("interrupted");
		expect(container.querySelector(".omp-work-head [role='img']")?.getAttribute("data-state")).toBe("stopped");
		expect(narrative()).toBe("Work interrupted");
	});
});

describe("streaming row to history row", () => {
	it("keeps one card element when the in-flight reply finalizes into its work row", async () => {
		const reply: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };
		const props = { expanded: false, live: true, onExpandedChange: () => {}, rowKey: "message-live" };
		await act(async () => useMessagesStore.setState({ streamingMessage: reply, streamingThinking: "Planning." }));
		await show(<ProcessGroup {...props} row={STREAMING_WORK_ROW} streaming />);
		const card = container.querySelector(".omp-live-step");
		expect(card).not.toBeNull();
		expect(narrative()).toBe("Thinking…");
		// message_end, in one commit: the reply leaves the stream and its call lands in the row
		// the transcript renders at the same key.
		const args = { command: "ls", intent: "Listing files" };
		await tools([["first", call("bash", args)]]);
		const finalized: AgentMessage = {
			...reply,
			content: [{ type: "toolCall", id: "first", name: "bash", arguments: args }],
		};
		const row = { ...STREAMING_WORK_ROW, messages: [finalized], stepCount: 1, toolCallIds: ["first"] };
		await act(async () => {
			useMessagesStore.setState({ streamingMessage: null, streamingThinking: "" });
			root.render(
				<I18nProvider>
					<ProcessGroup {...props} row={{ ...row, toolNames: ["bash"] }} />
				</I18nProvider>,
			);
		});
		await flush();
		expect(container.querySelector(".omp-live-step")).toBe(card);
		expect(narrative()).toBe("Listing files");
	});
});

describe("run clock", () => {
	it("counts a run that is still only thinking from the reply streaming now", async () => {
		const streaming: AgentMessage = { role: "assistant", content: [], timestamp: 4_000 };
		await act(async () => useMessagesStore.setState({ streamingMessage: streaming, streamingThinking: "Planning." }));
		await show(
			<ExecutionGroup expanded={false} live onExpandedChange={() => {}} stepCount={0} thinkingLive toolCallIds={[]}>
				<div />
			</ExecutionGroup>,
		);
		// The clock no longer pops in with the first call: it counts from the same message.
		expect(container.querySelector(".omp-work-head-clock")?.textContent).toBe("6s");
	});
});

describe("screen reader outcome", () => {
	const status = () => container.querySelector(".omp-live-step > [role='status']")?.textContent;
	it("announces how a watched run ended, in the head's own words", async () => {
		await tools([["one", call("bash", { command: "ls" })]]);
		await show(<LiveStepPeek thinkingLive={false} toolCallIds={["one"]} state="running" />);
		expect(status()).toBe("");
		await tools([["one", call("bash", { command: "ls" }, { status: "done", endTime: 2 })]]);
		await show(<LiveStepPeek thinkingLive={false} toolCallIds={["one"]} state="interrupted" />);
		expect(status()).toBe(narrative());
		expect(status()).toBeTruthy();
	});
	it("stays silent for a card that mounts finished", async () => {
		await tools([["one", call("bash", { command: "ls" }, { status: "done", endTime: 2 })]]);
		await show(<LiveStepPeek thinkingLive={false} toolCallIds={["one"]} state="complete" />);
		expect(status()).toBe("");
	});
});
