import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { type SubagentNode, useSubagentsStore } from "../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { WorkCrossfade } from "./WorkCrossfade";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
let transcriptMessages: AgentMessage[] = [];
Object.assign(window, {
	requestAnimationFrame: (callback: FrameRequestCallback) => {
		const id = ++sequence;
		frames.set(id, callback);
		return id;
	},
	cancelAnimationFrame: (id: number) => frames.delete(id),
	omp: { rpc: { command: async () => ({ success: true, data: { messages: transcriptMessages } }) } },
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
// React DOM must initialize only after the linkedom browser globals exist.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek } = await import("./LiveStepPeek");
let root: Root;
let container: HTMLElement;
const entry: ToolEntry = {
	toolName: "bash",
	args: { command: "echo first" },
	streamingArgs: "",
	result: undefined,
	isError: false,
	status: "running",
	startTime: 1,
	endTime: null,
};
const agent = (id: string, index: number, lastUpdate: number): SubagentNode => ({
	id,
	index,
	lastUpdate,
	status: "running",
	agent: "scout",
	parentToolCallId: "task",
});
async function flush() {
	const pending = [...frames.values()];
	frames.clear();
	await act(async () => {
		for (const callback of pending) callback(0);
	});
}
async function render(ids: string[], thinking = false) {
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={thinking} toolCallIds={ids} />
			</I18nProvider>,
		),
	);
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	transcriptMessages = [];
	Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
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
it("opens only for real output and keeps the same fixed viewport through overlapping step frames", async () => {
	await render([], true);
	expect(container.querySelector(".omp-work-stage")).toBeNull();
	await act(async () => useToolsStore.setState(toolEntriesState([["first", entry]])));
	await flush();
	await render(["first"]);
	const stage = container.querySelector<HTMLElement>(".omp-work-stage");
	expect(stage).not.toBeNull();
	const style = stage?.getAttribute("style");
	const stylesheet = readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");
	const stageRule = stylesheet.match(/\.omp-work-stage \{([^}]+)\}/)?.[1] ?? "";
	expect(stageRule).toContain("--omp-work-stage: clamp(");
	expect(stageRule).toContain("height: var(--omp-work-stage)");
	await act(async () =>
		useToolsStore.setState(
			toolEntriesState([
				["first", { ...entry, status: "done" }],
				["second", { ...entry, startTime: 2, args: { command: "echo second" } }],
			]),
		),
	);
	await flush();
	await render(["first", "second"]);
	expect(container.querySelector(".omp-work-stage")).toBe(stage);
	expect(stage?.getAttribute("style")).toBe(style);
	expect(stage?.querySelector("[data-outgoing]")?.textContent).toContain("echo first");
	expect(stage?.querySelector("[data-incoming]")?.textContent).toContain("echo second");
	await act(async () => vi.advanceTimersByTime(220));
	expect(stage?.querySelector("[data-outgoing]")).toBeNull();
});
it("keeps concurrent picks inside the fixed stage", async () => {
	useToolsStore.setState(
		toolEntriesState([
			["first", entry],
			["second", { ...entry, startTime: 2 }],
		]),
	);
	await render(["first", "second"]);
	expect(container.querySelectorAll(".omp-work-stage .omp-work-parallel-row")).toHaveLength(2);
	expect(container.querySelector(".omp-live-step > .omp-work-parallel")).toBeNull();
});
it("auto-follows newer running agents no faster than three seconds and respects a user pin", async () => {
	useToolsStore.setState(toolEntriesState([["task", { ...entry, toolName: "task" }]]));
	useSubagentsStore.getState().setSnapshots([agent("First", 0, 1), agent("Second", 1, 0)]);
	useSubagentsStore
		.getState()
		.surface("First")
		.setState(toolEntriesState([["child-first", entry]]));
	useSubagentsStore
		.getState()
		.surface("Second")
		.setState(toolEntriesState([["child-second", { ...entry, args: { command: "echo second agent" } }]]));
	await render(["task"]);
	const lanes = () => [...container.querySelectorAll<HTMLButtonElement>(".omp-work-card-button")];
	expect(lanes()[0]?.getAttribute("aria-current")).toBe("true");
	await act(async () => useSubagentsStore.getState().setSnapshots([agent("First", 0, 1), agent("Second", 1, 2)]));
	await flush();
	await act(async () => vi.advanceTimersByTime(2999));
	expect(lanes()[0]?.getAttribute("aria-current")).toBe("true");
	await act(async () => vi.advanceTimersByTime(1));
	expect(lanes()[1]?.getAttribute("aria-current")).toBe("true");
	await act(async () => lanes()[0]?.click());
	expect(lanes()[0]?.getAttribute("aria-current")).toBe("true");
	expect(
		container.querySelector(".omp-work-stage > .omp-work-crossfade > [data-incoming] .omp-live-step")?.textContent,
	).toContain("echo first");
	expect(container.querySelector(".omp-work-card .omp-live-step")).toBeNull();
	expect(container.querySelector(".omp-work-stage")).not.toBeNull();
	await act(async () => useSubagentsStore.getState().setSnapshots([agent("First", 0, 1), agent("Second", 1, 3)]));
	await flush();
	await act(async () => vi.advanceTimersByTime(6000));
	expect(lanes()[0]?.getAttribute("aria-current")).toBe("true");
});

it("swaps instantly without retaining an outgoing frame under reduced motion", async () => {
	Object.assign(window, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
	useToolsStore.setState(toolEntriesState([["first", entry]]));
	await render(["first"]);
	useToolsStore.setState(
		toolEntriesState([
			["first", { ...entry, status: "done" }],
			["second", { ...entry, startTime: 2 }],
		]),
	);
	await render(["first", "second"]);
	expect(container.querySelector("[data-outgoing]")).toBeNull();
	expect(container.querySelector(".omp-work-stage")).not.toBeNull();
});

it("keeps the last real surface dimmed through a calm wait, including its final output", async () => {
	useToolsStore.setState(toolEntriesState([["first", entry]]));
	await render(["first"]);
	const stage = container.querySelector(".omp-work-stage");
	useToolsStore.setState(
		toolEntriesState([
			["first", { ...entry, status: "done", result: { content: [{ type: "text", text: "final output" }] } }],
			["wait", { ...entry, toolName: "wait", startTime: 2 }],
		]),
	);
	await render(["first", "wait"]);
	expect(container.querySelector(".omp-work-stage")).toBe(stage);
	expect(stage?.getAttribute("data-settled")).toBe("true");
	expect(stage?.textContent).toContain("final output");
	expect(stage?.querySelector("[data-wait-line]")).toBeNull();
	expect(stage?.textContent).not.toContain("running");
});

it("restores a finished agent's real surface when mounting a hydrated live wait", async () => {
	transcriptMessages = [
		{
			role: "assistant",
			timestamp: 1,
			content: [{ type: "toolCall", id: "child", name: "bash", arguments: { command: "echo first" } }],
		},
		{
			role: "toolResult",
			timestamp: 2,
			toolCallId: "child",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "restored final output" }],
		},
	];
	useToolsStore.setState(
		toolEntriesState([
			["task", { ...entry, toolName: "task", status: "done" }],
			["wait", { ...entry, toolName: "wait", startTime: 2 }],
		]),
	);
	useSubagentsStore.getState().setSnapshots([{ ...agent("Finished", 0, 1), status: "completed" }]);
	useSubagentsStore
		.getState()
		.surface("Finished")
		.setState(
			toolEntriesState([
				[
					"child",
					{ ...entry, status: "done", result: { content: [{ type: "text", text: "restored final output" }] } },
				],
			]),
		);
	await render(["task", "wait"]);
	const stage = container.querySelector(".omp-work-stage");
	expect(stage?.getAttribute("data-settled")).toBe("true");
	expect(stage?.textContent).toContain("restored final output");
	expect(container.querySelector(".omp-work-card-button")?.getAttribute("aria-current")).toBe("true");
	expect(useSubagentsStore.getState().eventConsumers).toBe(0);
});

it("keeps short and long narrative layers in one full-width grid cell", async () => {
	await act(async () =>
		root.render(
			<WorkCrossfade identity="short" motion>
				<div className="omp-work-narrative">Wait</div>
			</WorkCrossfade>,
		),
	);
	await act(async () =>
		root.render(
			<WorkCrossfade identity="long" motion>
				<div className="omp-work-narrative">Waiting for Sleeper</div>
			</WorkCrossfade>,
		),
	);
	const fade = container.querySelector(".omp-work-crossfade");
	expect(fade?.querySelector("[data-incoming]")?.textContent).toBe("Waiting for Sleeper");
	expect(fade?.querySelector("[data-outgoing]")?.textContent).toBe("Wait");
	expect([...container.querySelectorAll<HTMLElement>(".omp-work-frame")].every(frame => !frame.style.width)).toBe(
		true,
	);
	const stylesheet = readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");
	const grid = stylesheet.match(/\.omp-work-crossfade \{([^}]+)\}/)?.[1] ?? "";
	const frame = stylesheet.match(/\.omp-work-frame \{([^}]+)\}/)?.[1] ?? "";
	expect(grid).toContain("grid-template-columns: minmax(0, 1fr)");
	expect(grid).toContain("width: 100%");
	expect(frame).toContain("grid-area: 1 / 1");
	expect(frame).toContain("width: 100%");
});

it("does not publish a half-written intent while tool arguments are streaming", async () => {
	useToolsStore.setState(
		toolEntriesState([
			[
				"wait",
				{
					...entry,
					toolName: "wait",
					status: "pending",
					args: { i: "Waiting for Slee" },
					streamingArgs: '{"i":"Waiting for Slee',
				},
			],
		]),
	);
	await render(["wait"]);
	expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Wait");
	useToolsStore.setState(
		toolEntriesState([["wait", { ...entry, toolName: "wait", args: { i: "Waiting for Sleeper" } }]]),
	);
	await render(["wait"]);
	expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Waiting for Sleeper");
});
