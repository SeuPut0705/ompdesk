import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSubagentsStore } from "../../stores/subagents";
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
	matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(HTMLElement.prototype, { focus() {} });
// React DOM must initialize only after the linkedom browser globals exist.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek } = await import("./LiveStepPeek");

let root: Root;
let container: HTMLElement;
const bash = (command: string, patch: Partial<ToolEntry> = {}): ToolEntry => ({
	toolName: "bash",
	args: { command },
	streamingArgs: "",
	result: undefined,
	isError: false,
	status: "running",
	startTime: 1,
	endTime: null,
	...patch,
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
async function tools(entries: Array<readonly [string, ToolEntry]>, partial?: Map<string, unknown>) {
	await act(async () =>
		useToolsStore.setState({ ...toolEntriesState(entries), ...(partial ? { partialResults: partial } : {}) }),
	);
	await flush();
}
const sub = () => container.querySelector(".omp-work-sub");

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
	useSubagentsStore.getState().reset();
	frames.clear();
	vi.useRealTimers();
});

it("names the step's command under an intent narrative instead of an empty reserved line", async () => {
	await tools([["run", bash("bun run check:types", { intent: "Checking the types" })]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["run"]} />);
	expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Checking the types");
	expect(sub()?.textContent).toBe("bun run check:types");
	expect(sub()?.getAttribute("title")).toBe("bun run check:types");
	expect(sub()?.getAttribute("aria-hidden")).toBeNull();
});

it("shows the latest progress line when the narrative already names the target", async () => {
	await tools([["run", bash("bun test")]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["run"]} />);
	expect(container.querySelector(".omp-work-narrative")?.textContent).toContain("bun test");
	const shell = container.querySelector(".omp-work-sub-shell");
	// Nothing to say yet: the line stays reserved and blank rather than made up.
	expect(sub()?.textContent).toBe("\u00a0");
	expect(sub()?.getAttribute("aria-hidden")).toBe("true");

	await tools(
		[["run", bash("bun test")]],
		new Map([["run", { content: [{ type: "text", text: "collecting\n 12 passed  \n\n" }] }]]),
	);
	expect(sub()?.textContent).toBe("12 passed");
	await tools(
		[["run", bash("bun test")]],
		new Map([["run", { content: [{ type: "text", text: "collecting\n12 passed\n40 passed" }] }]]),
	);
	expect(sub()?.textContent).toBe("40 passed");
	// The same reserved line throughout: filling it never changes the head's structure.
	expect(container.querySelector(".omp-work-sub-shell")).toBe(shell);
	expect(shell?.getAttribute("data-open")).toBe("true");
});

it("keeps live descriptions ahead of the step detail and folds the line when the run ends", async () => {
	const entries = [
		["one", bash("sleep 1", { intent: "Sleeping one" })],
		["two", bash("sleep 2", { intent: "Sleeping two", startTime: 2 })],
	] as const;
	await tools([...entries]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["one", "two"]} />);
	expect(sub()?.textContent).toContain("2 running at once");

	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["one", "two"]} state="complete" />);
	expect(container.querySelector(".omp-work-sub-shell")?.getAttribute("data-open")).toBe("false");
	expect(sub()?.textContent).toBe("\u00a0");
});
