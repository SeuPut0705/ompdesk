import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useLiveWorkStore } from "../../../stores/live-work";
import { useSessionStore } from "../../../stores/session";
import { useTodoStore } from "../../../stores/todo";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";

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
const { WorkspaceDock } = await import("../dock/WorkspaceDock");
const { LiveStepPeek } = await import("../LiveStepPeek");
await import("../dock/TodoSortableList");

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
		useLiveWorkStore.getState().setCarried("", state === "running");
		root.render(
			<I18nProvider>
				<LiveStepPeek
					thinkingLive={false}
					toolCallIds={["bash"]}
					state={state}
					carriesContext={state === "running"}
				/>
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
	useLiveWorkStore.getState().reset();
	useSessionStore.setState({ goal: null, goalState: null });
	useUiStore.setState({ dockCollapsed: {}, dockFocus: null });
});

describe("work context", () => {
	it("shows todo progress and the goal once: in the running work card, then back in the dock", async () => {
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

		await render("running");
		const work = container.querySelector(".omp-live-step");
		const todo = work?.querySelector(".omp-work-todo-toggle");
		expect(todo?.textContent).toBe("1/3Run the tests");
		expect(work?.querySelector("[data-goal-row]")?.textContent).toContain("Ship the release");
		expect(container.querySelector('section[aria-label="Todos"]')).toBeNull();
		expect(container.textContent?.split("Ship the release")).toHaveLength(2);

		// The row opens the same editable list in place.
		await act(async () => (todo as unknown as { click(): void }).click());
		expect(work?.querySelector(".omp-work-todo-list")?.textContent).toContain("Ship it");

		await render("complete");
		expect(container.querySelector(".omp-work-todo")).toBeNull();
		expect(container.querySelector('section[aria-label="Todos"]')).not.toBeNull();
		expect(container.textContent?.split("Ship the release")).toHaveLength(2);
	});
});
