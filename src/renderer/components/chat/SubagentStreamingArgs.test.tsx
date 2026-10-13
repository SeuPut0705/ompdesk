import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage, AgentProgress, RpcCommand } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSubagentsStore } from "../../stores/subagents";
import { toolEntriesState, useToolsStore } from "../../stores/tools";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Node, IS_REACT_ACT_ENVIRONMENT: true });
// React DOM must load after linkedom globals are installed.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek } = await import("./LiveStepPeek");
const { BashRenderer } = await import("../tools/BashRenderer");

const progress: AgentProgress = {
	id: "Sleeper",
	index: 0,
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Run sleep 60",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	requests: 1,
	tokens: 0,
	cost: 0,
	durationMs: 1000,
};
// The `toolcall_delta` texts a real `omp --mode rpc` subagent streamed for
// `sleep 60`, in order; every update's `partial.arguments` was still `{}` and
// only `toolcall_end` (≈1s after the first delta) carried parsed arguments.
const DELTAS = [
	'{"',
	"i",
	'":"',
	"Running",
	" requested",
	" sleep",
	" command",
	'","',
	"command",
	'":"',
	"sleep",
	" ",
	"60",
	'","',
	"timeout",
	'":',
	"70",
	',"',
	"cwd",
	'":',
	"null",
	"}",
];
const assistant: AgentMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call_sleep", name: "bash", arguments: {} }],
	timestamp: 2,
};

let root: Root;
let container: HTMLElement;
const commands: RpcCommand[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

async function flush() {
	await act(async () => {
		const pending = [...frames.values()];
		frames.clear();
		for (const frame of pending) frame(0);
	});
}

async function stream(deltas: readonly string[]) {
	await act(async () => {
		for (const delta of deltas)
			useSubagentsStore.getState().applyFrame({
				type: "subagent_event",
				payload: {
					id: progress.id,
					event: {
						type: "message_update",
						message: assistant,
						assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta, partial: assistant },
					},
				},
			});
	});
	await flush();
}

const lane = () => container.querySelector(".omp-work-stage > .omp-work-crossfade > [data-incoming] .omp-live-step");

beforeEach(async () => {
	commands.length = 0;
	Object.assign(window, {
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++frameId, callback);
			return frameId;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		omp: {
			rpc: {
				command: async (command: RpcCommand) => {
					commands.push(command);
					// Expanded before the call: the transcript holds only the assignment.
					return { success: true, data: { messages: [{ role: "user", content: "Run sleep 60", timestamp: 1 }] } };
				},
			},
		},
	});
	useToolsStore.setState(
		toolEntriesState([
			[
				"parent",
				{
					toolName: "task",
					args: {},
					status: "running",
					streamingArgs: "",
					result: null,
					isError: false,
					startTime: Date.now(),
					endTime: null,
				},
			],
		]),
	);
	useSubagentsStore.getState().applyFrame({
		type: "subagent_progress",
		payload: {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: progress.task,
			parentToolCallId: "parent",
			progress,
		},
	});
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={false} toolCallIds={["parent"]} />
			</I18nProvider>,
		),
	);
	await act(async () => container.querySelector<HTMLButtonElement>(".omp-work-card-button")?.click());
	await flush();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	frames.clear();
	useToolsStore.getState().reset();
	useSubagentsStore.getState().reset();
});

describe("an expanded agent lane while its bash call streams", () => {
	it("shows the command as soon as the streamed arguments spell it, never an empty terminal first", async () => {
		expect(commands.some(command => command.type === "get_subagent_messages")).toBe(true);
		await stream(DELTAS.slice(0, 2));
		// Nothing of the command has streamed yet: no bash surface with a bare `$` prompt line.
		expect(lane()?.getAttribute("data-surface")).not.toBe("bash");
		expect(lane()?.querySelector(".omp-bash-prompt")).toBeNull();

		await stream(DELTAS.slice(2, 11));
		expect(lane()?.getAttribute("data-surface")).toBe("bash");
		expect(lane()?.querySelector(".omp-bash-prompt")?.textContent).toContain("sleep");

		await stream(DELTAS.slice(11));
		expect(lane()?.querySelector(".omp-bash-prompt")?.textContent).toContain("sleep 60");
	});
});

describe("BashRenderer without a command", () => {
	it("renders no prompt line until a command exists", async () => {
		await act(async () =>
			root.render(
				<I18nProvider>
					<BashRenderer args={{}} result={null} isPartial livePreview toolCallId="streaming" />
				</I18nProvider>,
			),
		);
		expect(container.querySelector(".omp-bash-terminal")).not.toBeNull();
		expect(container.querySelector(".omp-bash-prompt")).toBeNull();
		expect(container.textContent).not.toContain("$");
	});
});
