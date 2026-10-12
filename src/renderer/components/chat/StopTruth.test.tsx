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
import { agentGroupState, agentWorkState, isInterruptedError } from "./WorkStatus";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// Load React DOM and surfaces after linkedom globals: this test exercises the DOM module boundary.
const { createRoot } = await import("react-dom/client");
const { ExecutionGroup } = await import("./ExecutionGroup");
const { LiveStepPeek } = await import("./LiveStepPeek");
let root: Root | undefined;
let container: HTMLElement | undefined;

function error(endTime: number, status: ToolEntry["status"] = "error"): ToolEntry {
	return {
		toolName: "bash",
		args: { command: "bun test" },
		status,
		streamingArgs: "",
		result: { content: [{ type: "text", text: "failed" }] },
		isError: true,
		startTime: 1,
		endTime,
	};
}
function stoppedRun(content: AgentMessage["content"] = []) {
	return buildHistoryRows(
		[
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "test", name: "bash", arguments: { command: "bun test" } }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "test",
				toolName: "bash",
				content: [{ type: "text", text: "failed" }],
				isError: true,
				timestamp: 5_000,
			},
			{ role: "assistant", content, stopReason: "aborted", errorMessage: "Request was aborted", timestamp: 20_000 },
		],
		"compact",
	)[0];
}
async function mount(stoppedAt: number | undefined, interrupted: boolean) {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<ExecutionGroup
					expanded={false}
					onExpandedChange={() => {}}
					stepCount={2}
					toolCallIds={["test", "done"]}
					stoppedAt={stoppedAt}
				>
					<div />
				</ExecutionGroup>
				<LiveStepPeek
					thinkingLive={false}
					toolCallIds={["test", "done"]}
					state={interrupted ? "interrupted" : "failed"}
					stoppedAt={stoppedAt}
				/>
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

describe("stop truth", () => {
	it("keeps a real failure failed after a later model-thinking stop", async () => {
		const row = stoppedRun([{ type: "thinking", thinking: "Investigating the failure" }]);
		if (row?.kind !== "process") throw new Error("Missing process");
		expect(row.stoppedAt).toBeUndefined();
		useToolsStore.setState(
			toolEntriesState([
				["test", error(5_000)],
				["done", { ...error(6_000), status: "done", isError: false }],
			]),
		);
		await mount(row.stoppedAt, false);
		expect(container?.querySelector(".omp-execution-group")?.getAttribute("data-state")).toBe("failed");
		expect(container?.querySelector(".omp-work-head [role='img']")?.getAttribute("data-state")).toBe("failed");
		expect(container?.querySelector(".omp-live-work-chip")?.getAttribute("data-state")).toBe("failed");
		expect(container?.querySelector(".omp-work-outcome li [role='img']")?.getAttribute("aria-label")).toBe("Failed");
	});
	it("uses the actual stop time consistently in summary, head, chip and outcome", async () => {
		const row = stoppedRun();
		if (row?.kind !== "process") throw new Error("Missing process");
		expect(row.stoppedAt).toBe(20_000);
		useToolsStore.setState(
			toolEntriesState([
				["test", error(19_500)],
				["done", error(22_000, "aborted")],
			]),
		);
		await mount(row.stoppedAt, true);
		expect(container?.querySelector(".omp-execution-group")?.getAttribute("data-state")).toBe("interrupted");
		expect(container?.querySelector(".omp-execution-group-summary")?.textContent).toContain("2 interrupted");
		expect(container?.querySelector(".omp-work-head [role='img']")?.getAttribute("data-state")).toBe("stopped");
		expect(container?.querySelector(".omp-live-work-chip")?.getAttribute("data-state")).toBe("stopped");
		expect(
			[...(container?.querySelectorAll(".omp-work-outcome li [role='img']") ?? [])].map(mark =>
				mark.getAttribute("aria-label"),
			),
		).toEqual(["Interrupted", "Interrupted", "Interrupted", "Interrupted"]);
	});
	it("does not reinterpret old errors or live errors and always interrupts explicit aborted calls", () => {
		expect(isInterruptedError(error(5_000), 20_000)).toBe(false);
		expect(isInterruptedError(error(20_000))).toBe(false);
		expect(isInterruptedError(error(19_000), 20_000)).toBe(true);
		expect(isInterruptedError({ ...error(22_000, "aborted"), isError: false })).toBe(true);
	});
	it.each([
		["started", "running"],
		["running", "running"],
		["pending", "running"],
		["idle", "running"],
		["parked", "running"],
		["failed", "failed"],
		["completed", "complete"],
		["aborted", "interrupted"],
		["cancelled", "interrupted"],
		["stale", "interrupted"],
		["future", "interrupted"],
		[undefined, "interrupted"],
	] as const)("maps %s from the canonical agent status table to %s", (status, expected) => {
		expect(agentGroupState(status)).toBe(expected);
		const work = status === "pending" ? "pending" : expected === "interrupted" ? "stopped" : expected;
		expect(agentWorkState(status)).toBe(work);
	});
});
