import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { useTodoStore } from "../../stores/todo";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(window as unknown as Record<string, unknown>, {
	innerWidth: 1280,
	innerHeight: 900,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	omp: { rpc: { setTodos: vi.fn(async () => ({ type: "response", command: "set_todos", success: true })) } },
});

const { createRoot } = await import("react-dom/client");
const { WorkspaceDock } = await import("./dock/WorkspaceDock");
const { LiveStepPeek } = await import("./LiveStepPeek");
await import("./dock/TodoSortableList");

const command: ToolEntry = {
	toolName: "bash",
	args: { command: "bun test" },
	streamingArgs: "",
	result: undefined,
	isError: false,
	endTime: null,
	status: "running",
	startTime: 1,
};

let container: HTMLElement;
let root: Root;

async function render(state: "running" | "complete"): Promise<void> {
	await act(async () => {
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={false} toolCallIds={["bash"]} state={state} liveTail={state === "running"} />
				<WorkspaceDock />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useTodoStore.getState().reset();
	useToolsStore.getState().reset();
	useSessionStore.setState({ goal: null, goalState: null });
	useUiStore.setState({ dockCollapsed: {}, dockFocus: null });
});

describe("todo progress and the goal", () => {
	it("live in the dock alone: the running work card draws neither, before and after the run", async () => {
		useToolsStore.setState(toolEntriesState([["bash", command]]));
		useTodoStore.getState().setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "Write the fix", status: "completed" },
					{ content: "Run the tests", status: "in_progress" },
					{ content: "Ship it", status: "pending" },
				],
			},
		]);
		useSessionStore.setState({ goal: { objective: "Ship the release" }, goalState: { status: "active" } });
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);

		for (const state of ["running", "complete"] as const) {
			await render(state);
			const work = container.querySelector(".omp-live-step");
			expect(work?.querySelector(".omp-work-todo, .omp-work-context")).toBeNull();
			expect(work?.textContent).not.toContain("Ship the release");
			expect(container.querySelector('section[aria-label="Todos"]')).not.toBeNull();
			expect(container.querySelector("[data-goal-dock]")?.textContent).toContain("Ship the release");
			expect(container.textContent?.split("Ship the release")).toHaveLength(2);
		}
	});
});

describe("the dock's island", () => {
	it("shows a subagent's row between turns and hides it while a turn runs, when the live card shows the lanes", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([{ id: "a1", index: 0, agent: "task", status: "running", lastUpdate: 0 }]);
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		for (const [streaming, shown] of [
			[true, false],
			[false, true],
		] as const) {
			useSessionStore.setState({ isStreaming: streaming });
			await render(streaming ? "running" : "complete");
			expect(container.querySelector("[data-workspace-island]") !== null, `streaming=${streaming}`).toBe(shown);
		}
		useSubagentsStore.getState().reset();
		useSessionStore.setState({ isStreaming: false });
	});
});
