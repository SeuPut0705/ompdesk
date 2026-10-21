import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useLiveWorkStore } from "../../stores/live-work";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { useTodoStore } from "../../stores/todo";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
Object.assign(window, {
	innerWidth: 1280,
	innerHeight: 900,
	requestAnimationFrame: (callback: FrameRequestCallback) => {
		const id = ++frameId;
		frames.set(id, callback);
		return id;
	},
	cancelAnimationFrame: (id: number) => frames.delete(id),
	omp: {
		rpc: {
			setTodos: vi.fn(async () => ({ success: true })),
			command: vi.fn(async () => ({ success: true, data: { messages: [] } })),
		},
	},
});
// React DOM and sortable components must load after the linkedom globals exist.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek } = await import("./LiveStepPeek");
const { ExecutionGroup } = await import("./ExecutionGroup");
const { WorkContext } = await import("./work/WorkContext");
const { WorkspaceDock } = await import("./dock/WorkspaceDock");
await import("./dock/TodoSortableList");
async function flushFrame() {
	const pending = [...frames.values()];
	frames.clear();
	await act(async () => {
		for (const callback of pending) callback(0);
	});
}
let root: Root;
let container: HTMLElement;
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
beforeEach(() => {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useToolsStore.getState().reset();
	useTodoStore.getState().reset();
	useLiveWorkStore.getState().reset();
	useSessionStore.setState({ goal: null, goalState: null });
	useSubagentsStore.getState().reset();
	useUiStore.setState({ dockFocus: null, dockCollapsed: {} });
	frames.clear();
	vi.useRealTimers();
});
it("pins concurrent calls live and switches directly without losing the list or clock", async () => {
	useToolsStore.setState(
		toolEntriesState([
			["test", command],
			["lint", { ...command, args: { command: "bun lint" } }],
		]),
	);
	useSubagentsStore.getState().setSnapshots([
		{
			id: "Scout",
			index: 0,
			agent: "scout",
			agentSource: "project",
			status: "running",
			lastUpdate: 1,
			parentToolCallId: "test",
		},
	]);
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={false} toolCallIds={["test", "lint"]} />
			</I18nProvider>,
		),
	);
	const lane = container.querySelector<HTMLButtonElement>(".omp-work-card-button");
	await act(async () => lane?.click());
	expect(lane?.getAttribute("aria-current")).toBe("true");
	// An open lane owns the stage and the strip: the main calls' picks wait until it closes.
	expect(container.querySelector(".omp-work-parallel")).toBeNull();
	expect(container.querySelectorAll(".omp-live-work-strip")).toHaveLength(1);
	expect(container.querySelector(".omp-live-work-strip-label")?.textContent).toBe("Scout");
	await act(async () => lane?.click());
	for (const index of [0, 1]) {
		await act(async () =>
			(container.querySelectorAll(".omp-work-parallel-row")[index] as unknown as { click(): void }).click(),
		);
		expect(container.querySelectorAll(".omp-work-parallel-row")).toHaveLength(2);
		expect(container.querySelectorAll(".omp-work-parallel-row")[index]?.getAttribute("aria-current")).toBe("true");
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-running")).toBe("true");
		expect(
			container.querySelector(".omp-work-stage > .omp-work-crossfade > [data-incoming] [data-mode=replay]"),
		).toBeNull();
		expect(lane?.getAttribute("aria-current")).toBeNull();
		expect(container.querySelector(".omp-work-clock")).not.toBeNull();
		expect(container.textContent).toContain("2 running at once");
	}
});
it("does not show a Thinking surface for a finished yield-only lane", async () => {
	useToolsStore.setState(toolEntriesState([["yield", { ...command, toolName: "yield", status: "done", endTime: 2 }]]));
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek nested state="complete" thinkingLive={false} toolCallIds={["yield"]} />
			</I18nProvider>,
		),
	);
	expect(container.querySelector(".omp-work-surface")).toBeNull();
	expect(container.textContent).not.toContain("Thinking");
});
it("only the designated live-tail card carries context, without mount-owned handoff", async () => {
	useTodoStore.getState().setPhases([{ name: "Work", tasks: [{ content: "Next task", status: "pending" }] }]);
	useLiveWorkStore.getState().setCarried("", true);
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={false} toolCallIds={[]} />
				<LiveStepPeek carriesContext thinkingLive={false} toolCallIds={[]} />
			</I18nProvider>,
		),
	);
	expect(container.querySelectorAll(".omp-work-todo")).toHaveLength(1);
	await act(async () => root.render(<I18nProvider>{null}</I18nProvider>));
	expect(useLiveWorkStore.getState().cards[""]).toBe(true);
});
it("opens and scrolls the carried todo for every edit focus signal", async () => {
	useTodoStore.getState().setPhases([{ name: "Work", tasks: [{ content: "Next task", status: "pending" }] }]);
	const scroll = vi.fn();
	Object.assign(HTMLElement.prototype, { scrollIntoView: scroll });
	await act(async () =>
		root.render(
			<I18nProvider>
				<WorkContext />
			</I18nProvider>,
		),
	);
	await act(async () => useUiStore.getState().focusDockCard("todo"));
	expect(container.querySelector(".omp-work-todo-toggle")?.getAttribute("aria-expanded")).toBe("true");
	expect(scroll).toHaveBeenCalled();
	await act(async () => (container.querySelector(".omp-work-todo-toggle") as unknown as { click(): void }).click());
	await act(async () => useUiStore.getState().focusDockCard("todo"));
	expect(container.querySelector(".omp-work-todo-toggle")?.getAttribute("aria-expanded")).toBe("true");
});
it("keeps a zero-task stock reminder visible and open", async () => {
	useTodoStore.getState().showReminder([{ content: "Unfinished stock task", status: "pending" }]);
	await act(async () =>
		root.render(
			<I18nProvider>
				<WorkContext />
			</I18nProvider>,
		),
	);
	expect(container.querySelector(".omp-work-todo-toggle")?.getAttribute("aria-expanded")).toBe("true");
	expect(container.querySelector(".omp-work-todo-list")).not.toBeNull();
});
it("clears stale todo dock focus when the transcript takes context", async () => {
	useSessionStore.setState({ planModeEnabled: true });
	useUiStore.setState({ dockCollapsed: { todo: false } });
	useTodoStore.getState().setPhases([
		{
			name: "Work",
			tasks: Array.from({ length: 12 }, (_, index) => ({ content: `Task ${index}`, status: "completed" as const })),
		},
	]);
	useTodoStore.getState().revealClosed();
	await act(async () =>
		root.render(
			<I18nProvider>
				<WorkspaceDock />
			</I18nProvider>,
		),
	);
	const viewAll = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
		button.textContent?.includes("view all 12 todos"),
	);
	expect(viewAll).toBeDefined();
	await act(async () => viewAll?.click());
	expect(container.querySelector("[data-testid=workspace-dock-resize]")).not.toBeNull();
	await act(async () => useLiveWorkStore.getState().setCarried("", true));
	expect(container.querySelector("[data-testid=workspace-dock-resize]")).toBeNull();
	expect(container.querySelector("[data-focused-card]")).toBeNull();
	await act(async () => useSessionStore.setState({ planModeEnabled: false }));
});
it("the focused card's height handle names its height and bounds, and steps with the keyboard", async () => {
	useUiStore.setState({ dockCollapsed: { todo: false } });
	useTodoStore.getState().setPhases([
		{
			name: "Work",
			tasks: Array.from({ length: 12 }, (_, index) => ({ content: `Task ${index}`, status: "completed" as const })),
		},
	]);
	useTodoStore.getState().revealClosed();
	await act(async () =>
		root.render(
			<I18nProvider>
				<WorkspaceDock />
			</I18nProvider>,
		),
	);
	const viewAll = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
		button.textContent?.includes("view all 12 todos"),
	);
	await act(async () => viewAll?.click());
	const handle = container.querySelector("[data-testid=workspace-dock-resize]");
	if (!handle) throw new Error("no resize handle");
	expect(handle.getAttribute("aria-valuemin")).toBe("200");
	expect(handle.getAttribute("aria-valuemax")).toBe("680");
	const press = async (key: string) => {
		const record = handle as unknown as Record<string, Record<string, (event: unknown) => void>>;
		const propsKey = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$")) ?? "";
		await act(async () => record[propsKey]?.onKeyDown?.({ key, preventDefault: () => {} }));
	};
	// Before any resize the handle reports the card's default cap (min(50 %, height − 300)), never a short list's height.
	expect(handle.getAttribute("aria-valuenow")).toBe("450");
	await press("ArrowDown");
	expect(handle.getAttribute("aria-valuenow")).toBe("402");
	await press("End");
	expect(handle.getAttribute("aria-valuenow")).toBe("680");
	await press("Home");
	expect(handle.getAttribute("aria-valuenow")).toBe("200");
	await press("ArrowUp");
	expect(handle.getAttribute("aria-valuenow")).toBe("248");
	await press("Enter");
	expect(handle.getAttribute("aria-valuenow")).toBe("248");
});
it("ignores todo focus already present when the context mounts", async () => {
	useTodoStore.getState().setPhases([{ name: "Work", tasks: [{ content: "Next task", status: "pending" }] }]);
	useUiStore.getState().focusDockCard("todo");
	const scroll = vi.fn();
	Object.assign(HTMLElement.prototype, { scrollIntoView: scroll });
	await act(async () =>
		root.render(
			<I18nProvider>
				<WorkContext />
			</I18nProvider>,
		),
	);
	expect(container.querySelector(".omp-work-todo-toggle")?.getAttribute("aria-expanded")).toBe("false");
	expect(scroll).not.toHaveBeenCalled();
});
it("starts an existing reminder open without scrolling on mount and only scrolls on a new reminder", async () => {
	useTodoStore.getState().setPhases([{ name: "Work", tasks: [{ content: "Stock task", status: "pending" }] }]);
	useTodoStore.getState().showReminder([{ content: "Stock task", status: "pending" }]);
	const scroll = vi.fn();
	Object.assign(HTMLElement.prototype, { scrollIntoView: scroll });
	await act(async () =>
		root.render(
			<I18nProvider>
				<WorkContext />
			</I18nProvider>,
		),
	);
	expect(container.querySelector(".omp-work-todo-toggle")?.getAttribute("aria-expanded")).toBe("true");
	expect(scroll).not.toHaveBeenCalled();
	await act(async () => useTodoStore.getState().clearReminder());
	await act(async () => useTodoStore.getState().showReminder([{ content: "Stock task", status: "pending" }]));
	expect(scroll).toHaveBeenCalledTimes(1);
});
it("returns a finished parallel pin to following even when the replay strip is hidden", async () => {
	useToolsStore.setState(
		toolEntriesState([
			["test", command],
			["lint", { ...command, args: { command: "bun lint" } }],
		]),
	);
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek stepsListed thinkingLive={false} toolCallIds={["test", "lint"]} />
			</I18nProvider>,
		),
	);
	await act(async () => container.querySelectorAll<HTMLButtonElement>(".omp-work-parallel-row")[0]?.click());
	await act(async () =>
		useToolsStore.setState(
			toolEntriesState([
				["test", { ...command, status: "done", endTime: 2 }],
				["lint", { ...command, args: { command: "bun lint" } }],
			]),
		),
	);
	await flushFrame();
	expect(container.querySelector(".omp-live-step")?.getAttribute("data-following")).toBe("true");
	expect(container.querySelector(".omp-live-step")?.getAttribute("data-running")).toBe("true");
	expect(
		container.querySelector(".omp-work-stage > .omp-work-crossfade > [data-incoming] [data-mode=replay]"),
	).toBeNull();
	expect(container.querySelector(".omp-work-narrative")?.textContent).toContain("bun lint");
});
it("updates a step's narrative without remounting its animated heading", async () => {
	useToolsStore.setState(toolEntriesState([["test", command]]));
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={false} toolCallIds={["test"]} />
			</I18nProvider>,
		),
	);
	const narrative = container.querySelector(".omp-work-narrative");
	await act(async () =>
		useToolsStore.setState(toolEntriesState([["test", { ...command, intent: "Checking source types" }]])),
	);
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={false} toolCallIds={["test"]} />
			</I18nProvider>,
		),
	);
	expect(container.querySelector(".omp-work-narrative")).toBe(narrative);
	expect(narrative?.textContent).toBe("Checking source types");
});
it("keeps head and lane clocks out of live regions and announces the stall only once", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	useToolsStore.setState(toolEntriesState([["test", command]]));
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={false} toolCallIds={["test"]} />
				<LiveStepPeek nested thinkingLive={false} toolCallIds={["test"]} />
			</I18nProvider>,
		),
	);
	expect(container.querySelectorAll(".omp-work-clock")).toHaveLength(2);
	for (const clock of container.querySelectorAll(".omp-work-clock")) {
		expect(clock.getAttribute("role")).toBeNull();
		expect(clock.getAttribute("aria-live")).toBeNull();
	}
	await act(async () => vi.advanceTimersByTimeAsync(12_000));
	const announcements = [...container.querySelectorAll(".sr-only[role=status]")].map(node => node.textContent);
	expect(announcements.every(text => !!text)).toBe(true);
	await act(async () => vi.advanceTimersByTimeAsync(1_000));
	expect([...container.querySelectorAll(".sr-only[role=status]")].map(node => node.textContent)).toEqual(
		announcements,
	);
});
it("keeps archived todos inside the finished work card across disclosure changes", async () => {
	const snapshots = [
		{
			id: "finished-todos",
			ts: 2,
			duringTurn: true,
			phases: [
				{
					name: "Work",
					tasks: [
						{ content: "Read", status: "completed" as const },
						{ content: "Count", status: "completed" as const },
						{ content: "Report", status: "completed" as const },
					],
				},
			],
		},
	];
	const renderGroup = (expanded: boolean) => (
		<I18nProvider>
			<ExecutionGroup
				expanded={expanded}
				onExpandedChange={() => {}}
				toolCallIds={[]}
				stepCount={3}
				todoSnapshots={snapshots}
			>
				<div>Archived steps</div>
			</ExecutionGroup>
		</I18nProvider>
	);
	await act(async () => root.render(renderGroup(false)));
	expect(container.querySelector(".omp-live-step [data-todo-snapshot]")).not.toBeNull();
	expect(container.querySelector(".omp-work-stage")).toBeNull();
	await act(async () => root.render(renderGroup(true)));
	const context = container.querySelector(".omp-live-step [data-todo-snapshot]");
	expect(context).not.toBeNull();
	const row = context?.querySelector<HTMLButtonElement>(".omp-work-context-row.omp-work-todo-toggle");
	expect(row?.getAttribute("aria-label")).toBe("Todos: 3/3");
	expect(row?.querySelector(".omp-work-todo-count")?.textContent).toBe("3/3");
	expect(context?.querySelector("details, summary")).toBeNull();
	expect(context?.querySelector("ul")).toBeNull();
	await act(async () => row?.click());
	expect(context?.querySelectorAll("li")).toHaveLength(3);
});
