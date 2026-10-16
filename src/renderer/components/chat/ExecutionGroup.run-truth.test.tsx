import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { buildHistoryRows } from "./chat-stream-utils";
import { runSpan } from "./work/work-run";

// What the card says at the turns of a real run, found by e2e/card-flows.e2e.ts:
// a plan proposal, a question, a command beside new agents, a run cut off by a relaunch.
const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// React DOM and the card load after the linkedom globals.
const { createRoot } = await import("react-dom/client");
const { ExecutionGroup } = await import("./ExecutionGroup");
let root: Root | undefined;
let container: HTMLElement | undefined;

function tool(toolName: string, args: Record<string, unknown>, done: boolean, startTime = 1_000): ToolEntry {
	return {
		toolName,
		args,
		status: done ? "done" : "running",
		streamingArgs: "",
		result: done ? { content: [{ type: "text", text: "ok" }] } : null,
		isError: false,
		startTime,
		endTime: done ? startTime + 500 : null,
	};
}

async function mount(toolCallIds: string[], live: boolean, stoppedAt?: number) {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<ExecutionGroup
					expanded={false}
					live={live}
					onExpandedChange={() => {}}
					stepCount={toolCallIds.length}
					toolCallIds={toolCallIds}
					stoppedAt={stoppedAt}
				>
					<div />
				</ExecutionGroup>
			</I18nProvider>,
		),
	);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	useToolsStore.getState().reset();
	useMessagesStore.getState().reset();
	useSubagentsStore.getState().reset();
});

describe("work card truth through a run", () => {
	it("reads a plan proposal's silent abort as the run's end, never as a stop", async () => {
		const call: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "plan", name: "write", arguments: { path: "local://PLAN.md" } }],
			timestamp: 1_000,
		};
		const result: AgentMessage = {
			role: "toolResult",
			toolCallId: "plan",
			toolName: "write",
			content: [{ type: "text", text: "Wrote local://PLAN.md" }],
			timestamp: 1_500,
		};
		// Stock stamps the abort it makes for a proposal (AgentSession `markPlanInternalAbortPending`).
		const silent: AgentMessage = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "__omp.silent_abort__",
			errorId: 0x0200_0000,
			timestamp: 2_000,
		};
		const rows = buildHistoryRows([call, result, silent], "compact");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (row?.kind !== "process") throw new Error("Missing work row");
		expect(row.stoppedAt).toBeUndefined();
		useToolsStore.setState(toolEntriesState([["plan", tool("write", { path: "local://PLAN.md" }, true)]]));
		await mount(["plan"], false, row.stoppedAt);
		expect(container?.querySelector(".omp-execution-group")?.getAttribute("data-state")).toBe("complete");
	});

	it("says the run waits for the person while a question is open", async () => {
		useToolsStore.setState(
			toolEntriesState([
				["lint", tool("bash", { command: "bun run lint" }, true)],
				["ask", tool("ask", { questions: [{ id: "env", question: "Which environment?" }] }, false, 2_000)],
			]),
		);
		await mount(["lint", "ask"], true);
		expect(container?.querySelector(".omp-work-sub")?.textContent).toBe("Waiting for your answer");
	});

	it("keeps a command's output on the stage while agents spawned beside it have nothing to show", async () => {
		useToolsStore.setState({
			...toolEntriesState([
				["build", tool("bash", { command: "bun run build" }, false, 1_000)],
				["agents", tool("task", { tasks: [{ name: "Scout", task: "Map the code" }] }, false, 1_100)],
			]),
			partialResults: new Map([["build", { content: [{ type: "text", text: "bundling renderer…" }] }]]),
		});
		useSubagentsStore.getState().applyFrame({
			type: "subagent_lifecycle",
			payload: {
				id: "Scout",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status: "started",
				parentToolCallId: "agents",
			},
		});
		await mount(["build", "agents"], true);
		const card = container?.querySelector(".omp-live-step");
		expect(card?.querySelector(".omp-work-card-button")?.textContent).toContain("Scout");
		expect(card?.querySelectorAll(".omp-work-parallel-row")).toHaveLength(2);
		expect(card?.querySelector(".omp-work-stage [data-incoming]")?.textContent).toContain("bundling renderer…");
	});

	it("runs a cut-off run's clock to its last call, not its last answer", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "build", name: "bash", arguments: {} }],
				timestamp: 1_000,
			},
			{ role: "toolResult", toolCallId: "build", toolName: "bash", content: [], timestamp: 4_000 },
			// The app quit while this one ran: stock wrote its call and never its result.
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "test", name: "bash", arguments: {} }],
				timestamp: 9_000,
			},
		];
		expect(runSpan([messages], ["build", "test"])).toEqual({ startedAt: 1_000, spanMs: 8_000 });
	});
});
